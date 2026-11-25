import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import worker from "../src/index";
import { workerEnv } from "./helpers/worker-env";
import { databaseHarness } from "@litscout/db/test/harness";
import { readOperations } from "@litscout/db/feed-read";
const parseCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

it.each([
  { label: "unscoped", scope: "", read: true, write: false },
  { label: "read", scope: "read", read: true, write: false },
  { label: "write only", scope: "write", read: false, write: true },
  { label: "read and write", scope: "read write", read: true, write: true },
  { label: "old grant", scope: "", read: false, write: false, old: true },
])(
  "limits library tools for $label and revokes immediately",
  async ({ scope, read, write, old }) => {
    const h = await databaseHarness("d1");
    close = h.close;
    const { env: base, ctx, store } = workerEnv();
    const db = h.db.$client as unknown as D1Database;
    const env = { ...base, DB: db, MCP_RESEARCH_TOOLS: "true" };
    await db.batch([
      db.prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES ('pap_oauth','Paired library paper','pairedlibrarypaper')",
      ),
      db.prepare(
        "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_oauth','arxiv','2401.12345')",
      ),
    ]);
    const call = (path: string, init?: RequestInit) =>
      worker.fetch(
        new Request(`https://worker.example${path}`, init) as never,
        env,
        ctx,
      );
    expect((await call("/mcp")).status).toBe(401);
    const registration = await call("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test client",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id } = (await registration.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = Buffer.from(hash).toString("base64url");
    const qs = new URLSearchParams({
      client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://worker.example/mcp",
      ...(scope ? { scope } : {}),
    });
    const adminHeaders = { authorization: `Bearer ${env.MGMT_TOKEN}` };
    const pair = await call("/admin/pair", {
      method: "POST",
      headers: adminHeaders,
    });
    const { code } = (await pair.json()) as { code: string };
    const authorizePath = `/authorize?${qs}`;
    let redirect: URL;
    if (old) {
      const oauth = getOAuthApi(
        {
          apiRoute: "/mcp",
          authorizeEndpoint: "/authorize",
          tokenEndpoint: "/token",
          apiHandler: {
            fetch: async () => new Response(null, { status: 404 }),
          },
          defaultHandler: {
            fetch: async () => new Response(null, { status: 404 }),
          },
          resourceMetadata: { resource: env.PUBLIC_URL + "/mcp" },
        },
        env,
      );
      const request = await oauth.parseAuthRequest(
        new Request(env.PUBLIC_URL + authorizePath),
      );
      const authorizationId = await store.consume(code, client_id);
      const grant = await oauth.completeAuthorization({
        request,
        userId: "owner",
        metadata: { clientId: client_id },
        scope: request.scope,
        props: { authorizationId },
      });
      redirect = new URL(grant.redirectTo);
    } else {
      const consent = await call(authorizePath);
      expect(consent.status).toBe(200);
      const html = await consent.text();
      const style = html.match(/<style>([^<]*)<\/style>/)?.[1];
      expect(style).toBeTruthy();
      expect(consent.headers.get("Content-Security-Policy")).toContain(
        "'sha256-" + createHash("sha256").update(style!).digest("base64") + "'",
      );
      expect(html).toContain("Requested access");
      expect(html).toContain("Access if approved");
      expect(html).toContain("Client name is unverified");
      expect(html).toContain(
        `<dt>Requested access</dt><dd>${scope ? (read && write ? "Read library and notes, Change library and notes" : read ? "Read library and notes" : "Change library and notes") : "No scopes requested"}`,
      );
      if (!write) expect(html).not.toContain("Change library and notes");
      const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
      expect(handle).toBeTruthy();
      const browser = scope === "read";
      const approved = await call("/authorize", {
        method: "POST",
        headers: {
          cookie: parseCookie(consent),
          origin: "https://worker.example",
          ...(browser ? { "Sec-Fetch-Mode": "navigate" } : {}),
        },
        body: new URLSearchParams({
          handle: handle!,
          decision: "approve",
          code,
        }),
      });
      expect(approved.status).toBe(browser ? 200 : 302);
      redirect = new URL(
        browser
          ? approved.headers.get("refresh")!.replace(/^0; url=/, "")
          : approved.headers.get("location")!,
      );
    }
    expect(redirect.searchParams.get("state")).toBe("test-state");
    const token = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        redirect_uri: "https://client.example/callback",
        code: redirect.searchParams.get("code")!,
        code_verifier: verifier,
        resource: "https://worker.example/mcp",
      }),
    });
    expect(token.status).toBe(200);
    const { access_token, refresh_token } = (await token.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(access_token).toBeTruthy();
    const mcp = (name?: string, args?: unknown, mcpToken = access_token) =>
      call("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${mcpToken}`,
          host: "worker.example",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: name ? "tools/call" : "tools/list",
          params: name ? { name, arguments: args } : {},
        }),
      });
    const response = await mcp();
    expect(response.status).toBe(200);
    const body = await response.text();
    for (const name of [
      "lookup_paper",
      "search_library",
      "get_paper",
      "search",
      "paper_links",
      "get_author",
      "coauthorship",
      "reviews",
      "venue",
      "research_context",
    ])
      if (read) expect(body).toContain(`"${name}"`);
      else expect(body).not.toContain(`"${name}"`);
    for (const name of ["save_paper", "add_note", "mark_paper", "capture_idea"])
      if (write) expect(body).toContain(`"${name}"`);
      else expect(body).not.toContain(`"${name}"`);
    async function tool(name: string, args: unknown) {
      const encoded = await (await mcp(name, args)).text();
      const message = JSON.parse(
        encoded.startsWith("{")
          ? encoded
          : encoded
              .split("\n")
              .find((line) => line.startsWith("data: "))!
              .slice(6),
      ) as {
        result: { content: { text: string }[]; isError?: boolean };
      };
      expect(message.result.isError).toBeUndefined();
      return JSON.parse(message.result.content[0]!.text).result;
    }
    if (write) {
      expect(
        await tool("save_paper", { query: "pap_oauth", dry_run: true }),
      ).toMatchObject({ status: "confirm" });
      expect(await tool("save_paper", { query: "pap_oauth" })).toMatchObject({
        status: "saved",
      });
      expect(
        await tool("add_note", {
          target: "pap_oauth",
          bodyMd: "Remember this paper",
        }),
      ).toMatchObject({ origin: "mcp", client: "Test client (unverified)" });
      expect(
        await tool("mark_paper", {
          paperId: "pap_oauth",
          action: "rate",
          rating: "down",
        }),
      ).toMatchObject({ rating: "down" });
      expect(
        await tool("mark_paper", { paperId: "pap_oauth", action: "read" }),
      ).toMatchObject({ readAt: expect.any(String) });
      expect(
        await tool("mark_paper", { paperId: "pap_oauth", action: "star" }),
      ).toMatchObject({ starred: true });
      if (read)
        expect(await tool("search_library", { q: "Paired" })).toMatchObject({
          items: [{ paperId: "pap_oauth" }],
        });
      expect(
        await db
          .prepare(
            "SELECT client AS name FROM notes WHERE target_id='pap_oauth'",
          )
          .first("name"),
      ).toBe("Test client");
      expect(
        await db
          .prepare("SELECT source FROM events WHERE kind='rate_down'")
          .first("source"),
      ).toBe("mcp:Test client");
      const operations = await readOperations(db, "2000-01-01", "2099-12-31");
      expect(operations.ratings).toMatchObject([
        { source: "mcp:Test client (unverified)" },
      ]);
    }
    if (read)
      expect(
        await tool("get_paper", {
          ids: "https://arxiv.org/abs/2401.12345v2",
          full: true,
        }),
      ).toMatchObject({
        record: { paperId: "pap_oauth" },
        summary: [],
        links: [],
        notes: write
          ? [
              {
                bodyMd: "Remember this paper",
                client: "Test client (unverified)",
              },
            ]
          : [],
      });
    if (read && write) {
      const refresh = await call("/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id,
          grant_type: "refresh_token",
          refresh_token,
          scope: "read",
        }),
      });
      expect(refresh.status).toBe(200);
      const narrowed = ((await refresh.json()) as { access_token: string })
        .access_token;
      const tools = await (await mcp(undefined, undefined, narrowed)).text();
      expect(tools).toContain('"search_library"');
      expect(tools).not.toContain('"save_paper"');
    }
    const revoked = await call("/admin/revoke", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ id: client_id }),
    });
    expect(revoked.status).toBe(200);
    expect([401, 403]).toContain((await mcp()).status);
  },
);
