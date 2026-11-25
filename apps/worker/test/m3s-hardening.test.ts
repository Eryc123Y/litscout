import { expect, it, vi } from "vitest";
import { app } from "../src/app";
import worker from "../src/index";
import { workerEnv } from "./helpers/worker-env";
import { databaseHarness } from "@litscout/db/test/harness";
import { digest } from "../src/auth/crypto";

const origin = "https://worker.example";
const workerRequest = (path: string, init?: RequestInit) =>
  new Request(origin + path, init) as Parameters<typeof worker.fetch>[0];
const token = (letter: string) => "lsk_" + letter.repeat(52);
const bearer = (letter: string) => ({
  Authorization: "Bearer " + token(letter),
});

it("authenticates a JSON POST before reading its request stream", async () => {
  const { env } = workerEnv();
  const pull = vi.fn((stream: ReadableStreamDefaultController) => {
    stream.enqueue(new TextEncoder().encode("{}"));
    stream.close();
  });
  const request = new Request(origin + "/api/v1/ingest/papers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
  } as RequestInit);
  const response = await app.fetch(request, {
    ...env,
    ACCESS_TEAM_DOMAIN: "team.example",
    ACCESS_AUD: "audience",
  });
  expect(response.status).toBe(401);
  expect(pull).not.toHaveBeenCalled();
});

it("separates new vault and ingest tokens while preserving migrated ingest access", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const client = db.$client as D1Database;
    const { env } = workerEnv();
    for (const [letter, scopes] of [
      ["I", ["ingest"]],
      ["V", ["vault"]],
      ["L", ["read", "ingest"]],
    ] as const)
      await client
        .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
        .bind(
          letter,
          letter,
          await digest(token(letter)),
          JSON.stringify(scopes),
        )
        .run();

    const call = (
      letter: string,
      path: string,
      method = "GET",
      body?: object,
    ) =>
      app.request(
        origin + "/api/v1" + path,
        {
          method,
          headers: { ...bearer(letter), "Content-Type": "application/json" },
          ...(body && { body: JSON.stringify(body) }),
        },
        { ...env, DB: client },
      );

    for (const [path, method, body, status] of [
      ["/vault/requests?state=queued", "GET", undefined, 200],
      ["/vault/index", "GET", undefined, 200],
      ["/vault/index/ids", "GET", undefined, 200],
      ["/vault/digests/2026-11-18", "GET", undefined, 200],
      ["/vault/budget", "GET", undefined, 200],
      [
        "/vault/requests/req_missing/claim",
        "POST",
        { claim: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
        200,
      ],
      [
        "/vault/requests/req_missing/resolve",
        "POST",
        { state: "rejected", reason: "Fixture" },
        200,
      ],
      [
        "/vault/report",
        "PUT",
        {
          writeEnabled: false,
          counts: {
            idea: 0,
            working_paper: 0,
            project: 0,
            paper_note: 0,
            brief: 0,
          },
          writes: [],
          handEdited: [],
          issues: [],
        },
        200,
      ],
    ] as const) {
      expect((await call("I", path, method, body)).status, path).toBe(403);
      expect((await call("V", path, method, body)).status, path).toBe(status);
    }
    expect((await call("I", "/budget")).status).toBe(200);
    expect((await call("V", "/budget")).status).toBe(403);
    expect((await call("V", "/vault/status")).status).toBe(403);

    await client
      .prepare("UPDATE api_tokens SET legacy_vault = 1 WHERE id = 'L'")
      .run();
    expect((await call("L", "/vault/requests?state=queued")).status).toBe(200);
    expect(await (await call("L", "/health")).json()).toMatchObject({
      data: { token: { scopes: ["read", "ingest"], legacyVault: true } },
    });
  } finally {
    await close();
  }
});

it("limits REST bearer lookups by connecting IP before they reach the database", async () => {
  const { env, ctx } = workerEnv();
  const first = vi.fn<() => Promise<object[]>>(async () => []);
  const prepare = vi.fn(() => ({
    bind: () => ({ all: async () => ({ results: await first() }) }),
  }));
  const db = { prepare } as unknown as D1Database;
  const call = (ip: string, path = "/api/v1/feed/days") =>
    worker.fetch(
      workerRequest(path, {
        headers: {
          ...bearer("X"),
          "CF-Connecting-IP": ip,
          "X-Forwarded-For": crypto.randomUUID(),
        },
      }),
      { ...env, DB: db },
      ctx,
    );
  first.mockResolvedValue([
    { id: "known", scopes: '["read"]', last_used_at: new Date().toISOString() },
  ]);
  for (let i = 0; i < 121; i++)
    expect((await call("192.0.2.1", "/api/v1/unknown")).status).toBe(404);
  first.mockResolvedValue([]);
  prepare.mockClear();
  for (let i = 0; i < 120; i++)
    expect((await call("192.0.2.1")).status).toBe(401);
  expect(prepare).toHaveBeenCalledTimes(120);
  for (const path of ["/api/v1/feed/days", "/api/v1/instance"]) {
    const response = await call("192.0.2.1", path);
    expect(response.status, path).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(prepare).toHaveBeenCalledTimes(120);
  expect((await call("192.0.2.2")).status).toBe(401);
});

it("only claims the export slot for same-origin browser requests or CLI clients", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const { env } = workerEnv();
    const call = (site?: string, method = "GET") =>
      app.request(
        origin + "/api/v1/backup",
        {
          method,
          headers: site ? { "Sec-Fetch-Site": site } : {},
        },
        { ...env, DB: db.$client as D1Database, LOCAL_DEV: "true" },
      );
    for (const site of ["cross-site", "same-site", "none"])
      expect((await call(site)).status).toBe(403);
    expect((await call()).status).toBe(403);
    expect((await call("cross-site", "HEAD")).status).toBe(200);
    expect((await call("same-origin")).status).toBe(200);
    expect((await call("same-origin")).status).toBe(429);
  } finally {
    await close();
  }
});

it("sets no-store on private responses across routers, including errors, and keeps public reads available", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const { env } = workerEnv();
    const bindings = {
      ...env,
      DB: db.$client as D1Database,
      LOCAL_DEV: "true",
      PUBLIC_FEED: "true",
    };
    for (const path of [
      "/feed/days",
      "/operations/health",
      "/ideas",
      "/library",
      "/backup",
      "/unknown",
    ]) {
      const response = await app.request(
        origin + "/api/v1" + path,
        undefined,
        bindings,
      );
      expect(response.headers.get("Cache-Control"), path).toBe("no-store");
    }
    const unauthorized = await app.request(
      origin + "/api/v1/feed/days",
      { headers: { Authorization: "Bearer invalid" } },
      bindings,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
    const publicResponse = await app.request(
      origin + "/api/v1/public/days",
      undefined,
      bindings,
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    await close();
  }
});

it("uses the web security policy on OAuth and admin responses", async () => {
  const { env, ctx } = workerEnv();
  const call = (path: string) => worker.fetch(workerRequest(path), env, ctx);
  const web = (await call("/")).headers;
  const csp = web.get("Content-Security-Policy");
  for (const directive of [
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // The reader may show arXiv PDFs beside a summary, and nothing else.
    "frame-src https://arxiv.org",
  ])
    expect(csp).toContain(directive);
  for (const path of [
    "/authorize",
    "/admin",
    "/admin/clients",
    "/.well-known/oauth-authorization-server",
  ]) {
    const headers = (await call(path)).headers;
    expect(headers.get("Content-Security-Policy"), path).toBe(csp);
    expect(headers.get("X-Frame-Options"), path).toBe(
      web.get("X-Frame-Options"),
    );
    expect(headers.get("X-Content-Type-Options"), path).toBe("nosniff");
    expect(headers.get("Referrer-Policy"), path).toBe("no-referrer");
  }
});

it.each([
  ["/register", "POST"],
  ["/token", "POST"],
  ["/authorize", "GET"],
])(
  "limits %s by IPv6 /64 and keeps adjacent subnets independent",
  async (path, method) => {
    const { env, ctx } = workerEnv();
    const call = (ip: string) =>
      worker.fetch(
        workerRequest(path, {
          method,
          headers: { "CF-Connecting-IP": ip },
        }),
        env,
        ctx,
      );
    expect((await call("2001:DB8:1:0::1")).status).not.toBe(429);
    for (let i = 2; i <= 10; i++)
      expect((await call("2001:0db8:0001::" + i)).status).not.toBe(429);
    const response = await call("2001:db8:1::f");
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call("2001:db8:1:1::1")).status).not.toBe(429);
  },
);
