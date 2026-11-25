import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { suggestionsPage } from "@litscout/pipeline/research-contracts";
import { writeReservation } from "@litscout/pipeline/write-reservation";
import * as vaultReads from "@litscout/db/vault-reads";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

const first = "a".repeat(64);
const second = "b".repeat(64);
const working = "c".repeat(64);
const project = "d".repeat(64);
const day = new Date().toISOString().slice(0, 10);
const paper = "pap_reading";
const ideaHash = "e".repeat(64);
const workingHash = "f".repeat(64);
const requestId = z.object({ data: z.object({ id: z.string() }) });
const combination = {
  kind: "combination",
  title: "Private combination",
  bodyMd: "Compare these two directions.",
  ideaIds: [first, second],
  paperIds: [paper],
  projectIds: [project],
};
const recommendation = {
  ...combination,
  kind: "paper_for_idea",
  title: "Private recommendation",
  ideaIds: [first],
};

it("reads working papers in vault order, queues research changes and keeps the private index off public routes", async () => {
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as unknown as D1Database;
  try {
    const run = (query: string, ...args: unknown[]) =>
      client
        .prepare(query)
        .bind(...args)
        .run();
    for (const [id, kind, title] of [
      [first, "idea", "Private depth idea"],
      [second, "idea", "Private second idea"],
      [working, "working_paper", "Private working draft"],
      [project, "project", "Private project"],
    ]) {
      await run(
        "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES (?,?,?,?,'{}',?,?,?,?)",
        id,
        "Research/" + title + ".md",
        kind,
        title,
        id === first ? ideaHash : id === working ? workingHash : id,
        id,
        id,
        day,
      );
    }
    await run(
      "INSERT INTO projects(id,slug,title,status,vault_note_id) VALUES (?,'project','Private project','active',?)",
      project,
      project,
    );
    await run(
      "INSERT INTO idea_index(id,vault_note_id,title,status,description,project_id,paper_ids,updated_at) VALUES (?,?,'Private depth idea','seed','Monocular depth',?,?,?)",
      first,
      first,
      project,
      JSON.stringify([paper]),
      day,
    );
    await run(
      "INSERT INTO idea_index(id,vault_note_id,title,status,updated_at) VALUES (?,?,'Private second idea','exploring',?)",
      second,
      second,
      day,
    );
    await run(
      "INSERT INTO working_paper_index(id,vault_note_id,title,idea_ids,paper_ids,updated_at) VALUES (?,?,'Private working draft',?,?,?)",
      working,
      working,
      JSON.stringify([second, first]),
      JSON.stringify([paper]),
      day,
    );
    for (const [id, title] of [
      [paper, "Depth baseline"],
      ["pap_related", "Monocular depth for video"],
      ["pap_far", "Large language models"],
    ] as const) {
      await run(
        "INSERT INTO papers(id,title,title_norm) VALUES (?,?,?)",
        id,
        title,
        title.toLowerCase(),
      );
    }
    await run(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES (?,'arxiv','2611.12345')",
      paper,
    );
    await run(
      "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES ('match','Research/Baseline.md','paper_note','Baseline','{\"arxiv\":\"2611.12345\"}','hash','body','fingerprint',?)",
      day,
    );
    await run(
      "INSERT INTO library_items(user_id,paper_id,status,added_via) VALUES ('u_owner',?,'reading','web')",
      paper,
    );
    await run("INSERT INTO feed_days(day) VALUES (?)", day);
    for (const id of [paper, "pap_related", "pap_far"])
      await run(
        "INSERT INTO feed_items(day,paper_id,source,rank_in_source) VALUES (?,?,'arxiv',1)",
        day,
        id,
      );

    const env = {
      ...workerEnv().env,
      DB: client,
      LOCAL_DEV: "true",
      PUBLIC_FEED: "true",
      VAULT_NAME: "Example Vault & Notes",
      INSTANCE_CONFIG: JSON.stringify({ language: "zh" }),
    };
    const request = (
      route: string,
      method = "GET",
      body?: unknown,
      headers?: Record<string, string>,
    ) =>
      app.request(
        "/api/v1" + route,
        {
          method,
          headers: { "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );
    const read = async (route: string) => {
      const response = await request(route);
      expect(response.status, route).toBe(200);
      return z.object({ data: z.unknown() }).parse(await response.json()).data;
    };
    expect(await read("/ideas/" + first)).toMatchObject({
      projectTitle: "Private project",
    });
    expect(await read("/vault/info")).toMatchObject({
      name: "Example Vault & Notes",
    });
    expect(await read("/working-papers")).toMatchObject({
      items: [{ id: working }],
    });
    expect(await read("/working-papers/" + working)).toMatchObject({
      ideas: [{ id: second }, { id: first }],
      reading: [
        {
          id: paper,
          status: "reading",
          vaultPath: "Research/Baseline.md",
          ideaIds: [first],
        },
      ],
      recent: [{ id: "pap_related", day }],
    });

    const digest = {
      day,
      bodyMd: "Daily report",
      suggestions: [
        {
          ...combination,
          projectIds: [project, working],
          paperIds: [paper, "pap_far"],
        },
        recommendation,
        { ...combination, kind: "new_idea", ideaIds: [], title: "To dismiss" },
      ],
    };
    const unknownIdea = await request("/digests/" + day, "PUT", {
      ...digest,
      suggestions: [{ ...recommendation, ideaIds: [working] }],
    });
    expect(unknownIdea.status).toBe(400);
    expect(await unknownIdea.json()).toMatchObject({
      error: { message: expect.stringMatching(/unknown idea/i) },
    });
    expect(await read("/suggestions")).toMatchObject({ items: [] });
    expect((await request("/digests/" + day, "PUT", digest)).status).toBe(200);
    expect(await read("/vault/digests/" + day)).toMatchObject({
      markdown: expect.stringContaining("## Idea suggestions"),
    });
    const { items } = suggestionsPage.parse(
      await read("/suggestions?day=" + day),
    );
    expect(items).toHaveLength(3);
    expect(
      items.find((item) => item.kind === "combination")?.references,
    ).toMatchObject({
      ideas: [
        { title: "Private depth idea" },
        { title: "Private second idea" },
      ],
      papers: [{ title: "Depth baseline" }, { title: "Large language models" }],
      projects: [{ title: "Private project" }],
    });
    const capture = items.find((item) => item.kind === "combination")!;
    const link = items.find((item) => item.kind === "paper_for_idea")!;
    const dismissed = items.find((item) => item.title === "To dismiss")!;

    expect(
      (
        await request(
          "/suggestions/" + capture.id + "/accept",
          "POST",
          {},
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
    const token = "lsk_" + "H".repeat(52);
    const hash = createHash("sha256").update(token).digest("hex");
    await run(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('reader','reader',?,'[\"read\"]')",
      hash,
    );
    const auth = { authorization: "Bearer " + token };
    for (const method of ["GET", "HEAD"])
      expect(
        (await request("/vault/captures", method, undefined, auth)).status,
      ).toBe(403);
    expect(
      (
        await request("/vault/requests", "POST", {
          kind: "capture",
          title: "Forged suggestion",
          suggestionId: capture.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/vault/requests",
          "POST",
          { kind: "capture", title: "Denied" },
          auth,
        )
      ).status,
    ).toBe(403);
    expect(
      (await request("/suggestions/" + link.id + "/accept", "POST", {}, auth))
        .status,
    ).toBe(403);

    const route = "/suggestions/" + capture.id + "/accept";
    const referenceLookup = vi.spyOn(vaultReads, "readVaultPapers");
    const accepted = await Promise.all([
      request(route, "POST", {}),
      request(route, "POST", {}),
    ]);
    expect(referenceLookup).toHaveBeenCalledWith(
      expect.anything(),
      ["pap_far"],
      "zh",
    );
    referenceLookup.mockRestore();
    const replies = await Promise.all(
      accepted.map(async (result) => {
        expect(result.status).toBe(200);
        return ((await result.json()) as { data: { requestId: string } }).data;
      }),
    );
    expect(replies[0]).toEqual(replies[1]);
    const captureId = replies[0]!.requestId;
    expect(
      (
        await request("/vault/requests/" + captureId, "PATCH", {
          title: "Edited capture",
          body: "Edited text",
        })
      ).status,
    ).toBe(200);
    expect(await read("/vault/captures")).toMatchObject([
      { id: captureId, title: "Edited capture", body: "Edited text" },
    ]);
    const linkRoute = "/suggestions/" + link.id + "/accept";
    const prior = requestId.parse(
      await (
        await request("/vault/requests", "POST", {
          kind: "link_paper",
          targetNoteId: first,
          paperId: paper,
        })
      ).json(),
    ).data.id;
    const alreadyQueued = await request(linkRoute, "POST", {});
    expect(alreadyQueued.status).toBe(200);
    expect(await alreadyQueued.json()).toMatchObject({
      data: { status: "accepted", requestId: prior },
    });
    expect((await request("/vault/requests/" + prior, "DELETE")).status).toBe(
      200,
    );
    const acceptedAgain = await request(linkRoute, "POST", {});
    expect(acceptedAgain.status).toBe(200);
    expect(await acceptedAgain.json()).toMatchObject({
      data: { status: "accepted", requestId: expect.not.stringMatching(prior) },
    });
    expect(
      (await request("/suggestions/" + dismissed.id + "/dismiss", "POST", {}))
        .status,
    ).toBe(200);
    expect(
      (await request("/suggestions/" + dismissed.id + "/accept", "POST", {}))
        .status,
    ).toBe(409);
    expect((await request("/digests/" + day, "PUT", digest)).status).toBe(200);
    expect(
      suggestionsPage.parse(
        await read("/suggestions?day=" + day + "&status=new"),
      ).items,
    ).toEqual([]);
    expect(await read("/vault/requests?state=queued")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "capture",
          body: "Edited text",
          references: expect.arrayContaining([
            expect.objectContaining({
              path: "Research/Private second idea.md",
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "link_paper",
          target: expect.objectContaining({ id: first }),
          paper: expect.objectContaining({ id: paper }),
        }),
      ]),
    );
    expect(await read("/vault/requests?state=queued")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: captureId,
          references: expect.not.arrayContaining([
            expect.objectContaining({
              path: "Research/Private working draft.md",
            }),
          ]),
        }),
      ]),
    );
    expect(await read("/vault/paper-note/" + paper)).toMatchObject({
      capturePending: true,
      linkPending: true,
    });
    const queued = await request("/vault/requests", "POST", {
      kind: "set_status",
      targetNoteId: first,
      status: "parked",
    });
    expect(queued.status).toBe(201);
    const {
      data: { id },
    } = (await queued.json()) as { data: { id: string } };
    expect(await read("/ideas/" + first)).toMatchObject({
      status: "seed",
      statusRequest: { id, status: "parked", state: "queued" },
    });
    expect(
      (
        await request("/vault/requests/" + id + "/resolve", "POST", {
          state: "rejected",
          reason: "Note changed",
        })
      ).status,
    ).toBe(200);
    expect(await read("/ideas/" + first)).toMatchObject({
      statusRequest: { state: "rejected", reason: "Note changed" },
    });
    expect(await read("/vault/status")).toMatchObject({
      rejected: [{ reason: "Note changed" }],
    });
    expect(
      (await request("/vault/requests/" + id + "?clear=rejected", "DELETE"))
        .status,
    ).toBe(200);
    expect(await read("/ideas/" + first)).toMatchObject({
      statusRequest: null,
    });
    expect(await read("/vault/status")).toMatchObject({
      rejected: [{ reason: "Note changed" }],
    });
    expect(
      (await request("/vault/requests/" + captureId, "DELETE")).status,
    ).toBe(200);
    expect(await read("/vault/captures")).toEqual([]);
    const retriedCapture = await request(route, "POST", {});
    const retryId = z
      .object({ data: z.object({ requestId: z.string() }) })
      .parse(await retriedCapture.json()).data.requestId;
    expect(retryId).not.toBe(captureId);
    const retryRoute = "/vault/requests/" + retryId;
    const retryClaim = crypto.randomUUID();
    await request(retryRoute + "/claim", "POST", { claim: retryClaim });
    expect(
      await (
        await request(retryRoute + "/resolve", "POST", {
          state: "rejected",
          reason: "Inbox unavailable",
          claim: retryClaim,
        })
      ).json(),
    ).toMatchObject({ data: { resolved: true } });
    expect(
      suggestionsPage.parse(await read("/suggestions?status=new")).items,
    ).toEqual([
      expect.objectContaining({
        id: capture.id,
        status: "new",
        requestId: null,
        resolvedAt: null,
      }),
    ]);
    const afterRejection = await request(route, "POST", {});
    expect(await afterRejection.json()).toMatchObject({
      data: {
        status: "accepted",
        requestId: expect.not.stringMatching(retryId),
      },
    });

    const draftResponse = await request("/vault/requests", "POST", {
      kind: "capture",
      title: "New draft",
      paperId: paper,
    });
    const draftId = z
      .object({ data: z.object({ id: z.string() }) })
      .parse(await draftResponse.json()).data.id;
    const draftClaim = crypto.randomUUID();
    const claimed = await request(
      "/vault/requests/" + draftId + "/claim",
      "POST",
      { claim: draftClaim },
    );
    expect(await claimed.json()).toMatchObject({
      data: { claimed: true, capture: { title: "New draft", body: "" } },
    });
    const draftRoute = "/vault/requests/" + draftId;
    expect(
      (await request(draftRoute, "PATCH", { title: "Too late" })).status,
    ).toBe(409);
    expect((await request(draftRoute, "DELETE")).status).toBe(409);
    await run(
      "UPDATE vault_requests SET claim_until='2000-01-01T00:00:00.000Z' WHERE id=?",
      draftId,
    );
    expect(await read("/vault/captures")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: draftId, applying: false }),
      ]),
    );
    expect(await read("/vault/status")).toMatchObject({
      queued: expect.arrayContaining([
        expect.objectContaining({ id: draftId, applying: false }),
      ]),
    });
    expect(
      (await request(draftRoute, "PATCH", { title: "Edited after timeout" }))
        .status,
    ).toBe(200);
    expect(
      await (
        await request(draftRoute + "/resolve", "POST", {
          state: "applied",
          claim: draftClaim,
        })
      ).json(),
    ).toMatchObject({ data: { resolved: false } });
    expect(
      await (
        await request(draftRoute + "/claim", "POST", {
          claim: crypto.randomUUID(),
        })
      ).json(),
    ).toMatchObject({
      data: { claimed: true, capture: { title: "Edited after timeout" } },
    });
    await run(
      "UPDATE vault_requests SET claim_until='2000-01-01T00:00:00.000Z' WHERE id=?",
      draftId,
    );
    expect((await request(draftRoute, "DELETE")).status).toBe(200);

    const added = await request("/vault/requests", "POST", {
      kind: "add_reading",
      targetNoteId: working,
      paperId: "pap_related",
    });
    expect(added.status).toBe(201);
    expect(
      (
        await request("/vault/requests", "POST", {
          kind: "make_paper_note",
          paperId: "pap_related",
        })
      ).status,
    ).toBe(201);
    const hashes = (
      await client
        .prepare(
          "SELECT DISTINCT kind,base_hash FROM vault_requests ORDER BY kind",
        )
        .all()
    ).results;
    expect(hashes).toEqual([
      { kind: "add_reading", base_hash: workingHash },
      { kind: "capture", base_hash: null },
      { kind: "link_paper", base_hash: ideaHash },
      { kind: "make_paper_note", base_hash: null },
      { kind: "set_status", base_hash: ideaHash },
    ]);
    expect(await read("/working-papers/" + working)).toMatchObject({
      reading: [{ id: paper }, { id: "pap_related", pending: true }],
      recent: [],
    });

    const limit = vi.fn(async () => ({ allowed: false, retryAfter: 30 }));
    const limitedEnv = {
      ...env,
      PAIRING_STORE: {
        ...env.PAIRING_STORE,
        idFromName: (name: string) => name,
        get: () => ({ allowRequest: limit }),
      } as unknown as typeof env.PAIRING_STORE,
    };
    const limited = await app.request(
      "/api/v1/vault/requests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "link_paper",
          targetNoteId: first,
          paperId: paper,
        }),
      },
      limitedEnv,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(limit).toHaveBeenCalledWith(60);

    for (const route of [
      "/ideas",
      "/working-papers",
      "/suggestions",
      "/vault/captures",
      "/vault/requests",
      "/vault/info",
      "/digests/" + day,
    ]) {
      expect((await request("/public" + route)).status).toBe(404);
    }
    for (const route of [
      "/public/days",
      "/public/days/" + day,
      "/public/papers/" + paper,
      "/instance",
    ]) {
      expect(await (await request(route)).text()).not.toMatch(
        /Private |Edited text|Example Vault|suggestions|captures/,
      );
    }
  } finally {
    await close();
  }
}, 60_000);

it("stores final digest suggestions atomically and rejects attempts to replace them with an ingest token", async () => {
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as unknown as D1Database;
  try {
    const token = "lsk_" + "I".repeat(52);
    const hash = createHash("sha256").update(token).digest("hex");
    await client
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('ingest','ingest',?,'[\"ingest\"]')",
      )
      .bind(hash)
      .run();
    const env = { ...workerEnv().env, DB: client };
    const put = (suggestions: unknown[]) =>
      app.request(
        "/api/v1/digests/" + day,
        {
          method: "PUT",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            day,
            bodyMd: "Final report",
            final: true,
            suggestions,
          }),
        },
        env,
      );
    const original = {
      ...combination,
      kind: "new_idea",
      title: "First proposal",
      ideaIds: [],
    };
    expect((await put([original])).status).toBe(200);
    expect((await put([original])).status).toBe(200);
    await put([{ ...original, title: "Later proposal" }]);
    expect(
      (await client.prepare("SELECT title FROM suggestions").all()).results,
    ).toEqual([{ title: "First proposal" }]);
  } finally {
    await close();
  }
});

it("replaces regenerated digest suggestions and limits new suggestions across languages", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const client = db.$client as unknown as D1Database;
    const env = { ...workerEnv().env, DB: client, LOCAL_DEV: "true" };
    const proposals = Array.from({ length: 10 }, (_, index) => ({
      kind: "new_idea",
      title: "First draft " + index,
      bodyMd: "Try this direction.",
      ideaIds: [],
      projectIds: [],
      paperIds: [paper],
    }));
    const put = (
      lang: "en" | "zh",
      suggestions: typeof proposals,
      final = false,
    ) =>
      app.request(
        "/api/v1/digests/" + day,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            day,
            lang,
            bodyMd: "Daily report",
            suggestions,
            final,
          }),
        },
        env,
      );
    const active = () =>
      client
        .prepare(
          "SELECT title,status FROM suggestions WHERE deleted_at IS NULL ORDER BY title",
        )
        .all<{ title: string; status: string }>()
        .then(({ results }) => results);
    expect((await put("en", proposals)).status).toBe(200);
    await client
      .prepare(
        "UPDATE suggestions SET status=CASE title WHEN 'First draft 0' THEN 'accepted' ELSE 'dismissed' END WHERE title IN ('First draft 0','First draft 1')",
      )
      .run();
    const revised = proposals.map((item) => ({
      ...item,
      title: item.title.replace("First", "Second"),
    }));
    const regenerated = await put("en", revised);
    expect(regenerated.status).toBe(200);
    const { meta } = (await regenerated.json()) as {
      meta: { rowsWritten: number };
    };
    expect(meta.rowsWritten).toBeLessThanOrEqual(
      writeReservation("/digests/" + day, { suggestions: revised }),
    );
    expect(await active()).toEqual([
      { title: "First draft 0", status: "accepted" },
      { title: "First draft 1", status: "dismissed" },
      ...revised.map(({ title }) => ({ title, status: "new" })),
    ]);
    expect((await put("zh", proposals, true)).status).toBe(200);
    expect(
      (await active()).filter(({ status }) => status === "new"),
    ).toHaveLength(10);
    expect((await put("en", [proposals[2]!])).status).toBe(200);
    expect(await active()).toEqual([
      { title: "First draft 0", status: "accepted" },
      { title: "First draft 1", status: "dismissed" },
      { title: "First draft 2", status: "new" },
    ]);
    expect((await put("en", [])).status).toBe(200);
    expect((await active()).map(({ status }) => status)).toEqual([
      "accepted",
      "dismissed",
    ]);
  } finally {
    await close();
  }
});
