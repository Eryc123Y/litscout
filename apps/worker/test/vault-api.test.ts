import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { registerVaultTools } from "../src/mcp-vault";
import { workerEnv } from "./helpers/worker-env";

const h = (text: string) => createHash("sha256").update(text).digest("hex");
it("retains conventions in the last private sync report and exposes only the count on unmatched papers", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const env = {
      ...workerEnv().env,
      LOCAL_DEV: "true",
      DB: db.$client as unknown as D1Database,
      VAULT_CONVENTIONS: JSON.stringify({
        ideaTag: "lab/idea",
        workingPaperTag: "lab/draft",
        projects: ["Projects/*.md"],
      }),
    };
    const get = (route: string) => app.request("/api/v1" + route, {}, env);
    const put = (report: unknown) =>
      app.request(
        "/api/v1/vault/report",
        {
          method: "PUT",
          body: JSON.stringify(report),
          headers: { "Content-Type": "application/json" },
        },
        env,
      );
    expect(await (await get("/vault/status")).json()).toMatchObject({
      data: {
        last: null,
        conventionSettings: {
          ideaTag: "lab/idea",
          workingPaperTag: "lab/draft",
          projects: ["Projects/*.md"],
        },
      },
    });
    const report = {
      writeEnabled: false,
      counts: {
        idea: 0,
        working_paper: 0,
        project: 1,
        paper_note: 0,
        brief: 0,
      },
      writes: [],
      handEdited: [],
      issues: [],
    };
    expect((await put(report)).status).toBe(200);
    expect(await (await get("/vault/status")).json()).toMatchObject({
      data: { last: report },
    });
    expect(
      await (await get("/vault/paper-note/pap_example")).json(),
    ).toMatchObject({
      data: { path: null, pending: false },
    });
    const conventions = {
      ideaTag: "lab/idea",
      ideaNotes: 0,
      workingPaperTag: "lab/draft",
      workingPaperNotes: 0,
      paperNotesWithoutIdentifiers: {
        count: 1,
        paths: ["Papers/Unmatched.md"],
      },
      possibleNonProjects: 1,
      excludedNotes: 2,
      privateNotes: 3,
    };
    expect((await put({ ...report, conventions })).status).toBe(200);
    expect(
      (
        await put({
          ...report,
          conventions: { ...conventions, excludedPaths: ["Hidden.md"] },
        })
      ).status,
    ).toBe(400);
    const status = await get("/vault/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      data: { last: { ...report, conventions } },
    });
    const paper = await get("/vault/paper-note/pap_example");
    const payload = await paper.json();
    expect(payload).toMatchObject({
      data: { path: null, notesWithoutIdentifiers: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("Papers/Unmatched.md");
  } finally {
    await close();
  }
});

it("requires vault scope for the private index and leaves dry-run GETs free of database writes", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const read = "lsk_" + "A".repeat(52),
      vault = "lsk_" + "B".repeat(52),
      write = "lsk_" + "C".repeat(52);
    for (const [scope, token] of [
      ["read", read],
      ["vault", vault],
      ["write", write],
    ] as const)
      await db.run(
        sql`INSERT INTO api_tokens(id,name,hash,scopes) VALUES (${scope},${scope},${h(token)},${JSON.stringify([scope])})`,
      );
    const env = {
      ...workerEnv().env,
      PUBLIC_FEED: "true",
      DB: db.$client as unknown as D1Database,
    };
    const request = (
      route: string,
      token?: string,
      method = "GET",
      body?: unknown,
    ) =>
      app.request(
        "/api/v1" + route,
        {
          method,
          headers: {
            ...(token ? { authorization: "Bearer " + token } : {}),
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );
    expect((await request("/vault/status", read)).status).toBe(403);
    expect((await request("/vault/requests?state=queued", read)).status).toBe(
      403,
    );
    expect((await request("/vault/requests?state=queued", vault)).status).toBe(
      200,
    );
    expect((await request("/vault/index", vault)).status).toBe(200);
    expect(
      await db.get(sql`SELECT last_used_at FROM api_tokens WHERE id='vault'`),
    ).toEqual({ last_used_at: null });
    expect((await request("/public/vault/status")).status).toBe(404);
    const hash = h("example");
    const note = {
      id: h("Idea.md"),
      kind: "idea",
      title: "Tip",
      path: "Idea.md",
      hash,
      bodyHash: hash,
      frontmatter: { status: "seed" },
    };
    const payload = { snapshot: hash, previous: null, part: 0, notes: [note] };
    expect((await request("/vault/index", write, "PUT", payload)).status).toBe(
      403,
    );
    expect(
      (
        await request("/vault/index", vault, "PUT", {
          ...payload,
          // Bodies are opt-in for projects, ideas and drafts only.
          notes: [
            { ...note, kind: "paper_note", frontmatter: {}, body: "Private" },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await request("/vault/index", vault, "PUT", payload)).status).toBe(
      200,
    );
    expect(
      (
        await request("/vault/index", vault, "PUT", {
          snapshot: hash,
          previous: null,
          parts: 1,
          count: 1,
          changes: 1,
        })
      ).status,
    ).toBe(200);
    for (const route of [
      "/ideas",
      "/projects",
      "/vault/paper-note/pap_example",
    ]) {
      expect((await request(route, read)).status).toBe(200);
      expect((await request(route, vault)).status).toBe(403);
    }
    const idea = await request("/ideas/" + note.id, read);
    expect(await idea.json()).toMatchObject({
      data: { title: "Tip", path: "Idea.md" },
    });
    const queued = await request("/vault/requests", write, "POST", {
      kind: "set_status",
      targetNoteId: note.id,
      status: "parked",
    });
    const entry = (await queued.json()) as { data: { id: string } };
    expect(queued.status).toBe(201);
    const pending = await request("/vault/requests?state=queued", vault);
    expect(await pending.json()).toMatchObject({
      data: [{ baseHash: hash, target: { path: "Idea.md" } }],
    });
    expect(
      (await request("/vault/requests/" + entry.data.id, write, "DELETE"))
        .status,
    ).toBe(200);
  } finally {
    await close();
  }
});

it("requires opt-in and the matching scope to register vault MCP tools", () => {
  const reads = [
    "research_context",
    "list_ideas",
    "get_idea",
    "get_note",
    "list_suggestions",
    "list_working_papers",
    "get_working_paper",
    "list_vault_requests",
  ];
  const writes = [
    "capture_idea",
    "request_link",
    "set_idea_status",
    "add_reading",
    "make_paper_note",
    "cancel_vault_request",
    "resolve_suggestion",
  ];
  for (const enabled of [undefined, "false", "true"]) {
    for (const [read, write, expected] of [
      [true, true, [...reads, ...writes]],
      [true, false, reads],
      [false, true, writes],
      [false, false, []],
    ] as const) {
      const registerTool = vi.fn();
      registerVaultTools(
        { registerTool } as never,
        {
          ...workerEnv().env,
          MCP_RESEARCH_TOOLS: enabled,
        },
        { read, write, identity: "fixture" },
      );
      expect(registerTool.mock.calls.map(([name]) => name)).toEqual(
        enabled === "true" ? expected : [],
      );
    }
  }
});

it("returns a generic 400 for invalid JSON bytes and syntax on vault routes", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const env = {
      ...workerEnv().env,
      LOCAL_DEV: "true",
      DB: db.$client as unknown as D1Database,
    };
    const send = (route: string, method: string, body?: BodyInit) =>
      app.request(
        "/api/v1" + route,
        { method, body, headers: { "Content-Type": "application/json" } },
        env,
      );
    for (const [route, method] of [
      ["/vault/index", "PUT"],
      ["/vault/report", "PUT"],
      ["/vault/requests", "POST"],
      ["/vault/requests/req_bad", "DELETE"],
      ["/vault/requests/req_bad/claim", "POST"],
      ["/vault/requests/req_bad/resolve", "POST"],
    ] as const) {
      const response = await send(route, method, '{"secret": fixture');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR", message: "Invalid JSON" },
      });
    }
    const text = new TextEncoder();
    const bytes = new Uint8Array([
      ...text.encode('{"kind":"capture","title":"'),
      0xff,
      ...text.encode('"}'),
    ]);
    const response = await send("/vault/requests", "POST", bytes);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "Invalid JSON" },
    });
    expect(
      (await send("/vault/requests/req_bad", "DELETE", "\uFEFF")).status,
    ).toBe(400);
    const badMatch = await send("/vault/matches?note=%7B", "GET");
    expect(badMatch.status).toBe(400);
    expect(await badMatch.json()).toMatchObject({
      error: { message: "Invalid JSON" },
    });
    expect(await db.all(sql`SELECT id FROM vault_requests`)).toEqual([]);
  } finally {
    await close();
  }
});
