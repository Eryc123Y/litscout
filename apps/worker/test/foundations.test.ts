import { SCHEMA_VERSION } from "@litscout/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { migrationStatements } from "@litscout/db/test/harness";
let worker: Miniflare;
let access: Miniflare;
let privateKey: CryptoKey;
let token: string;
const rawToken = "lsk_" + "A".repeat(52);
const hash = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
function localWorker(bindings: Record<string, string>, jwk: unknown) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".artifacts/worker-test.js",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        PAIRING_STORE: { className: "PairingStore", useSQLite: true },
        SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
      },
      bindings: {
        PUBLIC_URL: "https://worker.example",
        INSTANCE_CONFIG: JSON.stringify({
          name: "PRIVATE_INSTANCE",
          language: "zh",
          timezone: "Asia/Shanghai",
          topics: ["PRIVATE_TOPIC"],
        }),
        MGMT_TOKEN: "m".repeat(40),
        CONSENT_SECRET: "s".repeat(40),
        ...bindings,
      },
      outboundService: () => Response.json({ keys: [jwk] }),
    }),
  );
}
beforeAll(async () => {
  await build({
    entryPoints: ["apps/worker/src/index.ts"],
    outfile: ".artifacts/worker-test.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: JSON.stringify("test-sha") },
  });
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test",
    alg: "RS256",
  };
  worker = localWorker({}, jwk);
  access = localWorker(
    {
      ACCESS_TEAM_DOMAIN: "team.example",
      ACCESS_AUD: "test-audience",
      MCP_RESEARCH_TOOLS: "true",
    },
    jwk,
  );
  for (const instance of [worker, access]) {
    const db = await instance.getD1Database("DB");
    for (const statement of migrationStatements())
      await db.prepare(statement).run();
    await db
      .prepare(
        "INSERT INTO feed_days(day,status) VALUES ('2026-11-17','pending')",
      )
      .run();
  }
  token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://team.example")
    .setAudience("test-audience")
    .setExpirationTime("5m")
    .sign(privateKey);
}, 30_000);
afterAll(async () => {
  await Promise.all([worker?.dispose(), access?.dispose()]);
});
const request = (
  instance: Miniflare,
  path: string,
  headers: Record<string, string> = {},
) => instance.dispatchFetch("https://worker.example" + path, { headers });
it("returns health with build and real database schema information in workerd", async () => {
  const res = await request(worker, "/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect((await request(worker, "/api/v1/health")).status).toBe(401);
  const healthToken = "lsk_" + "H".repeat(52);
  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_health','health',?,'[\"read\"]')",
    )
    .bind(await hash(healthToken))
    .run();
  const detailed = await request(worker, "/api/v1/health", {
    authorization: "Bearer " + healthToken,
  });
  expect(detailed.status).toBe(200);
  expect(await detailed.json()).toMatchObject({
    success: true,
    data: {
      version: "0.0.0",
      gitSha: "test-sha",
      database: { reachable: true, schemaVersion: SCHEMA_VERSION },
      bindings: { DB: true, OAUTH_KV: true },
    },
  });
});
it("rejects missing, malformed, unknown, revoked and wrong-scope bearer tokens", async () => {
  expect((await request(worker, "/api/v1/feed/days")).status).toBe(503);
  for (const header of ["Basic x", "Bearer bad", "Bearer " + rawToken])
    expect(
      (await request(worker, "/api/v1/feed/days", { authorization: header }))
        .status,
    ).toBe(401);
  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes,revoked_at) VALUES ('tok_test','test',?,?,'2026-11-17T00:00:00Z')",
    )
    .bind(await hash(rawToken), JSON.stringify(["read"]))
    .run();
  expect(
    (
      await request(worker, "/api/v1/feed/days", {
        authorization: "Bearer " + rawToken,
      })
    ).status,
  ).toBe(401);
  await db
    .prepare("UPDATE api_tokens SET revoked_at=NULL,scopes='[\"write\"]'")
    .run();
  expect(
    (
      await request(worker, "/api/v1/feed/days", {
        authorization: "Bearer " + rawToken,
      })
    ).status,
  ).toBe(403);
  await db.prepare("UPDATE api_tokens SET scopes='[\"read\"]'").run();
  const res = await request(worker, "/api/v1/feed/days", {
    authorization: "Bearer " + rawToken,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    success: true,
    data: [{ day: "2026-11-17" }],
  });
  const first = await db
    .prepare("SELECT last_used_at FROM api_tokens WHERE id='tok_test'")
    .first("last_used_at");
  await request(worker, "/api/v1/feed/days", {
    authorization: "Bearer " + rawToken,
  });
  expect(
    await db
      .prepare("SELECT last_used_at FROM api_tokens WHERE id='tok_test'")
      .first("last_used_at"),
  ).toBe(first);
});
it("keeps public and OAuth paths outside Access while protecting private routes", async () => {
  for (const path of ["/", "/public/ping", "/health"]) {
    expect((await request(access, path)).status).toBe(200);
  }
  expect((await request(access, "/mcp")).status).toBe(401);
  expect(
    (await request(access, "/.well-known/oauth-authorization-server")).status,
  ).toBe(200);
  expect((await request(access, "/app/private")).status).toBe(401);
  expect((await request(worker, "/app/private")).status).toBe(503);
  expect((await request(access, "/api/v1/feed/days")).status).toBe(401);
  expect(
    (
      await request(access, "/app/private", {
        "Cf-Access-Jwt-Assertion": "bad",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(access, "/app/private", {
        "Cf-Access-Jwt-Assertion": token,
      })
    ).status,
  ).toBe(200);
  const wrong = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://team.example")
    .setAudience("wrong")
    .setExpirationTime("5m")
    .sign(privateKey);
  expect(
    (
      await request(access, "/api/v1/feed/days", {
        "Cf-Access-Jwt-Assertion": wrong,
      })
    ).status,
  ).toBe(401);
});
it("returns envelopes and all validation field paths", async () => {
  const res = await request(access, "/api/v1/feed/days?limit=0&before=bad", {
    "Cf-Access-Jwt-Assertion": token,
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      fields: [{ path: "limit" }, { path: "before" }],
    },
  });
  const absent = await request(access, "/api/v1/missing", {
    "Cf-Access-Jwt-Assertion": token,
  });
  expect(absent.status).toBe(404);
  expect(await absent.json()).toMatchObject({
    success: false,
    error: { code: "NOT_FOUND" },
  });
});

const parseCookie = (
  response: Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
it("completes the original OAuth pairing and revocation flow in workerd without Access", async () => {
  const call = (
    path: string,
    init?: Parameters<Miniflare["dispatchFetch"]>[1],
  ) =>
    access.dispatchFetch(`https://worker.example${path}`, {
      ...init,
      redirect: "manual",
    });
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
  });
  const consent = await call(`/authorize?${qs}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const adminHeaders = { authorization: "Bearer " + "m".repeat(40) };
  const pair = await call("/admin/pair", {
    method: "POST",
    headers: adminHeaders,
  });
  const { code } = (await pair.json()) as { code: string };
  const approved = await call("/authorize", {
    method: "POST",
    headers: { cookie: parseCookie(consent), origin: "https://worker.example" },
    body: new URLSearchParams({ handle: handle!, decision: "approve", code }),
  });
  expect(approved.status).toBe(302);
  const redirect = new URL(approved.headers.get("location")!);
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
  const { access_token } = (await token.json()) as { access_token: string };
  expect(access_token).toBeTruthy();
  const mcp = () =>
    call("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        host: "worker.example",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
  const response = await mcp();
  expect(response.status).toBe(200);
  const tools = await response.text();
  expect(tools).toContain('"search_library"');
  expect(tools).toContain('"reviews"');
  const revoked = await call("/admin/revoke", {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/json" },
    body: JSON.stringify({ id: client_id }),
  });
  expect(revoked.status).toBe(200);
  expect([401, 403]).toContain((await mcp()).status);
});

it("enforces authorize and admin IP budgets in workerd", async () => {
  for (let i = 0; i < 10; i++)
    expect(
      (
        await access.dispatchFetch("https://worker.example/authorize", {
          method: "POST",
          headers: { "CF-Connecting-IP": "192.0.2.10" },
          redirect: "manual",
          body: new URLSearchParams(),
        })
      ).status,
    ).not.toBe(429);
  expect(
    (
      await access.dispatchFetch("https://worker.example/authorize", {
        method: "POST",
        headers: { "CF-Connecting-IP": "192.0.2.10" },
        redirect: "manual",
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await access.dispatchFetch("https://worker.example/authorize", {
        method: "POST",
        headers: { "CF-Connecting-IP": "192.0.2.11" },
        redirect: "manual",
      })
    ).status,
  ).not.toBe(429);
  for (let i = 0; i < 30; i++)
    expect(
      (
        await request(access, "/admin/clients", {
          "CF-Connecting-IP": "192.0.2.12",
        })
      ).status,
    ).toBe(401);
  expect(
    (
      await request(access, "/admin/clients", {
        "CF-Connecting-IP": "192.0.2.12",
      })
    ).status,
  ).toBe(429);
  expect(
    (
      await request(access, "/admin/clients", {
        "CF-Connecting-IP": "192.0.2.13",
      })
    ).status,
  ).toBe(401);
  expect((await request(access, "//app/x")).status).toBe(401);
  expect((await request(access, "/%2Fapp/x")).status).toBe(400);
  expect((await request(access, "/unknown.txt")).status).toBe(404);
  // The HTTP URL parser has already removed these segments before the Worker sees them.
  expect((await request(access, "/app/../x")).status).toBe(404);
});

it("rejects expired bearer tokens before updating their usage", async () => {
  const expired = "lsk_" + "E".repeat(52);
  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes,expires_at) VALUES ('tok_expired','expired',?,'[\"read\"]','2000-01-01T00:00:00.000Z')",
    )
    .bind(await hash(expired))
    .run();
  expect(
    (
      await request(worker, "/api/v1/feed/days", {
        authorization: "Bearer " + expired,
      })
    ).status,
  ).toBe(401);
  expect(
    await db
      .prepare("SELECT last_used_at FROM api_tokens WHERE id='tok_expired'")
      .first("last_used_at"),
  ).toBeNull();
  expect(
    (
      await request(access, "/api/v1/health", {
        "Cf-Access-Jwt-Assertion": token,
      })
    ).status,
  ).toBe(401);
});
it("P1 verifies Access assertions and cookies before returning private instance data", async () => {
  const full = {
    name: "PRIVATE_INSTANCE",
    language: "zh",
    timezone: "Asia/Shanghai",
    topics: ["PRIVATE_TOPIC"],
    publicFeed: false,
  };
  const authenticated: Record<string, string>[] = [
    { "Cf-Access-Jwt-Assertion": token },
    { cookie: `CF_Authorization=${token}` },
  ];
  for (const headers of authenticated) {
    const response = await request(access, "/api/v1/instance", headers);
    expect(await response.json()).toMatchObject({ success: true, data: full });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const head = await access.dispatchFetch(
      "https://worker.example/api/v1/instance",
      { method: "HEAD", headers },
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
  }
  const anonymous: Record<string, string>[] = [
    {},
    { "Cf-Access-Jwt-Assertion": "invalid" },
    { cookie: "CF_Authorization=invalid" },
    { authorization: "Bearer invalid" },
  ];
  for (const headers of anonymous)
    expect(
      await (await request(access, "/api/v1/instance", headers)).json(),
    ).toEqual({ success: true, data: { name: "LitScout" } });
});
it("P1 requires a valid read scope for optional bearer authentication", async () => {
  const db = await access.getD1Database("DB"),
    raw = "lsk_" + "G".repeat(52);
  await db
    .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
    .bind("tok_instance", "instance", await hash(raw), JSON.stringify(["read"]))
    .run();
  const headers = { authorization: `Bearer ${raw}` };
  expect(
    await (await request(access, "/api/v1/instance", headers)).json(),
  ).toMatchObject({
    data: { name: "PRIVATE_INSTANCE", topics: ["PRIVATE_TOPIC"] },
  });
  for (const sql of [
    "UPDATE api_tokens SET scopes='[\"ingest\"]' WHERE id='tok_instance'",
    "UPDATE api_tokens SET scopes='[\"read\"]',revoked_at='2026-11-17T00:00:00Z' WHERE id='tok_instance'",
  ]) {
    await db.prepare(sql).run();
    expect(
      await (await request(access, "/api/v1/instance", headers)).json(),
    ).toEqual({ success: true, data: { name: "LitScout" } });
  }
});

it("requires same-origin JSON for Access-authenticated writes and leaves bearer writes alone", async () => {
  const route = "https://worker.example/api/v1/ingest/feed-day";
  const body = JSON.stringify({
    day: "2026-11-18",
    status: "final",
    counts: {},
  });
  const send = (headers: Record<string, string>) =>
    access.dispatchFetch(route, { method: "POST", body, headers });
  const accessHeader = { "Cf-Access-Jwt-Assertion": token };
  expect(
    (
      await send({
        ...accessHeader,
        "Content-Type": "text/plain",
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        ...accessHeader,
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        ...accessHeader,
        "Content-Type": "text/plain",
        "Sec-Fetch-Site": "same-origin",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        ...accessHeader,
        "Content-Type": "application/json",
        Origin: "https://elsewhere.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        ...accessHeader,
        "Content-Type": "application/json; charset=utf-8",
        "Sec-Fetch-Site": "same-origin",
        Origin: "https://worker.example",
      })
    ).status,
  ).toBe(200);
  expect(
    (await send({ ...accessHeader, "Content-Type": "application/json" }))
      .status,
  ).toBe(200);
  const bearer = "lsk_" + "Z".repeat(52);
  const db = await access.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_csrf','csrf',?,'[\"ingest\"]')",
    )
    .bind(await hash(bearer))
    .run();
  expect(
    (
      await send({
        Authorization: "Bearer " + bearer,
        "Content-Type": "text/plain",
        "Sec-Fetch-Site": "cross-site",
      })
    ).status,
  ).toBe(200);
});
