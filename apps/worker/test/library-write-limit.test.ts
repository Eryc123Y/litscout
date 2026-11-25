import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { dailyCaps } from "../src/library-write-limit";
import worker from "../src/index";
import { workerEnv } from "./helpers/worker-env";

const tokens = ["A", "B", "C"].map((suffix) => "lsk_" + suffix.repeat(52));
let env: ReturnType<typeof workerEnv>["env"];
let close: () => Promise<void>;

beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  const db = h.db.$client as unknown as D1Database;
  env = { ...workerEnv().env, DB: db, LOCAL_DEV: "true" };
  for (const [i, token] of tokens.entries()) {
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ).toString("hex");
    await db
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes,last_used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        "tok_limit_" + i,
        "limited",
        hash,
        '["read","write"]',
        new Date().toISOString(),
      )
      .run();
  }
});
afterAll(async () => close?.());

function request(
  path: string,
  method = "POST",
  token?: string,
  bindings = env,
) {
  return app.request(
    "/api/v1" + path,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    },
    bindings,
  );
}
async function expectLimited(response: Response) {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await response.json()).toMatchObject({
    success: false,
    error: { code: "RATE_LIMITED" },
  });
}

it("limits save attempts to 20 per token without charging a different token or the Access owner", async () => {
  for (let i = 0; i < 20; i++)
    expect((await request("/library/save", "POST", tokens[0])).status).toBe(
      400,
    );
  await expectLimited(await request("/library/save", "POST", tokens[0]));
  expect((await request("/library/save", "POST", tokens[1])).status).toBe(400);
  expect((await request("/library/save")).status).toBe(400);
});

it("shares the Access owner's 60-write limit across note mutations and events, excluding reads", async () => {
  for (let i = 0; i < 15; i++) {
    for (const [path, method] of [
      ["/notes", "POST"],
      ["/notes/note_example", "PATCH"],
      ["/notes/note_example", "DELETE"],
      ["/events", "POST"],
    ] as const)
      expect((await request(path, method)).status).toBe(400);
  }
  await expectLimited(await request("/notes/note_example", "PATCH"));
  await expectLimited(await request("/events"));
  expect((await request("/notes?target=pap_other", "GET")).status).toBe(200);
  expect((await request("/events", "POST", tokens[0])).status).toBe(400);
});

it("shares daily save and activity caps across OAuth clients, bearer tokens and the Access owner", async () => {
  const { env: base, store, ctx } = workerEnv();
  // Smaller caps keep the arithmetic below: 5 identities fill one day.
  const bindings = {
    ...base,
    DB: env.DB!,
    LOCAL_DEV: "true",
    LIBRARY_DAILY_CAPS: "save:100,activity:300",
  };
  await bindings.DB.prepare(
    "INSERT INTO papers(id,title,title_norm) VALUES ('pap_quota','Quota fixture','quotafixture')",
  ).run();
  vi.setSystemTime(new Date("2026-11-18T23:50:00Z"));
  const redirectUri = "https://client.example/callback";
  const resource = bindings.PUBLIC_URL + "/mcp";
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const unused = { fetch: () => new Response(null, { status: 404 }) };
  const oauth = getOAuthApi(
    {
      apiRoute: "/mcp",
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      resourceMetadata: { resource },
      apiHandler: unused,
      defaultHandler: unused,
    },
    bindings,
  );
  const call = (path: string, init: RequestInit) =>
    worker.fetch(
      new Request(bindings.PUBLIC_URL + path, init) as Parameters<
        typeof worker.fetch
      >[0],
      bindings,
      ctx,
    );
  const paired: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { clientId } = await oauth.createClient({
      clientName: "Quota fixture client " + i,
      redirectUris: [redirectUri],
      tokenEndpointAuthMethod: "none",
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "write",
      resource,
    });
    const request = await oauth.parseAuthRequest(
      new Request(bindings.PUBLIC_URL + "/authorize?" + params),
    );
    const { code } = await store.create();
    const authorizationId = await store.consume(code, clientId);
    const { redirectTo } = await oauth.completeAuthorization({
      request,
      userId: "owner",
      metadata: {},
      scope: request.scope,
      props: { authorizationId, libraryWrite: true },
    });
    const response = await call("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: new URL(redirectTo).searchParams.get("code")!,
        code_verifier: verifier,
        resource,
      }),
    });
    expect(response.status).toBe(200);
    paired.push(
      ((await response.json()) as { access_token: string }).access_token,
    );
  }

  async function tool(token: string, name: string, args: object) {
    const response = await call("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  for (const [perIdentity, path, method, toolName, args] of [
    [
      20,
      "/library",
      "POST",
      "save_paper",
      { query: "pap_quota", dry_run: true },
    ],
    [
      60,
      "/library/pap_quota",
      "PATCH",
      "mark_paper",
      { paperId: "pap_quota", action: "star" },
    ],
  ] as const) {
    // Three OAuth clients and two API tokens leave one slot before the daily cap.
    await Promise.all([
      ...paired.slice(0, 3).map(async (token) => {
        for (let i = 0; i < perIdentity; i++)
          expect(await tool(token, toolName, args)).not.toContain(
            '"isError":true',
          );
      }),
      ...tokens.slice(0, 2).map(async (token, index) => {
        for (let i = 0; i < perIdentity - index; i++)
          expect((await request(path, method, token, bindings)).status).toBe(
            400,
          );
      }),
    ]);
    expect(await tool(paired[0]!, toolName, args)).toContain(
      "Retry after 60 seconds",
    );
    const attempts = await Promise.all([
      request(path, method, tokens[2], bindings),
      request(path, method, undefined, bindings),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([400, 429]);
    for (const response of attempts.filter(({ status }) => status === 429)) {
      expect(response.headers.get("retry-after")).toBe("600");
      await expectLimited(response);
    }
    expect(await tool(paired[3]!, toolName, args)).toContain(
      "Retry after 600 seconds",
    );
  }
  await expectLimited(
    await request("/library/save", "POST", undefined, bindings),
  );
  await expectLimited(
    await request("/library/pap_example", "DELETE", undefined, bindings),
  );
  await expectLimited(
    await request("/vault/requests", "POST", undefined, bindings),
  );
  expect((await request("/library", "GET", undefined, bindings)).status).toBe(
    200,
  );

  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
  expect((await request("/library", "POST", tokens[0], bindings)).status).toBe(
    400,
  );
  expect(
    (await request("/library/pap_example", "PATCH", tokens[0], bindings))
      .status,
  ).toBe(400);
}, 60_000);

it("defaults the instance daily caps to 200 saves and 2,000 activity attempts", () => {
  expect(dailyCaps({})).toEqual({ save: 200, activity: 2000 });
  expect(dailyCaps({ LIBRARY_DAILY_CAPS: "save:100,activity:300" })).toEqual({
    save: 100,
    activity: 300,
  });
  expect(dailyCaps({ LIBRARY_DAILY_CAPS: "save:0,activity:abc,x:5" })).toEqual({
    save: 200,
    activity: 2000,
  });
});
