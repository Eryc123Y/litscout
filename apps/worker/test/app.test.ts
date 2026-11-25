import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app, scheduled } from "../src/app";
import { requiredScope, verifyAccess } from "../src/api-auth";
import { databaseHarness } from "@litscout/db/test/harness";
import { createApiToken, listRuns } from "@litscout/db";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { AppEnv } from "../src/env";
import { workerEnv } from "./helpers/worker-env";
let harness: Awaited<ReturnType<typeof databaseHarness>>;
let env: AppEnv;
beforeAll(async () => {
  harness = await databaseHarness("d1");
  env = {
    ...workerEnv().env,
    PUBLIC_URL: "https://example.org",
    DB: harness.db.$client as unknown as D1Database,
    LOCAL_DEV: "true",
  } as AppEnv;
});
afterAll(async () => {
  await harness?.close();
});
const request = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request("https://example.org" + path, { headers }), env);
it("serves local development, validates queries, paginates and records only a cron run", async () => {
  expect((await request("/health")).status).toBe(200);
  expect((await request("/api/v1/feed/days?limit=bad")).status).toBe(400);
  expect(
    (await request("/api/v1/feed/days?limit=1&before=2026-11-17")).status,
  ).toBe(200);
  expect((await request("/app/private")).status).toBe(200);
  expect((await request("/public/days")).status).toBe(200);
  expect((await request("/missing")).status).toBe(404);
  expect((await request("/api/v1/missing")).status).toBe(404);
  await scheduled(env, Date.parse("2026-11-17T00:00:00Z"));
  expect(await listRuns(harness.db)).toMatchObject([
    { kind: "cron", stats: { stub: true } },
  ]);
  expect(requiredScope("POST", "/api/v1/ingest/papers")).toBe("ingest");
  expect(requiredScope("PATCH", "/api/v1/notes/a")).toBe("write");
  expect(requiredScope("HEAD", "/api/v1/feed/days")).toBe("read");
  expect(requiredScope("GET", "/api/v1/ingest/prune")).toBe("read");
  expect(requiredScope("POST", "/api/v1/ingest/prune")).toBe("ingest");
});
it("checks bearer format, hash, scopes and usage without the local-dev bypass", async () => {
  const token = "lsk_" + "B".repeat(52);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  expect(
    (await request("/api/v1/feed/days", { authorization: "Basic x" })).status,
  ).toBe(401);
  expect(
    (await request("/api/v1/feed/days", { authorization: "Bearer " + token }))
      .status,
  ).toBe(401);
  await createApiToken(harness.db, { name: "read", hash, scopes: ["read"] });
  expect(
    (await request("/api/v1/feed/days", { authorization: "Bearer " + token }))
      .status,
  ).toBe(200);
});
it("fails closed for missing bindings and hides unexpected database failures", async () => {
  const noDb = { ...env, DB: undefined, LOCAL_DEV: undefined };
  expect(
    (await app.fetch(new Request("https://example.org/health"), noDb)).status,
  ).toBe(503);
  expect(
    (await app.fetch(new Request("https://example.org/app/private"), noDb))
      .status,
  ).toBe(503);
  await expect(scheduled(noDb, 0)).rejects.toThrow("DB");
  const broken = {
    ...env,
    DB: {
      prepare: () => {
        throw new Error("private internal details");
      },
    } as unknown as D1Database,
  };
  const response = await app.fetch(
    new Request("https://example.org/api/v1/feed/days"),
    broken,
  );
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private internal details");
});
it("verifies signed Access assertions and rejects bad configuration, signatures and audiences", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        keys: [{ ...(await exportJWK(publicKey)), kid: "unit", alg: "RS256" }],
      }),
    ),
  );
  const settings = {
    ...env,
    ACCESS_TEAM_DOMAIN: "unit-team.example",
    ACCESS_AUD: "unit-audience",
    LOCAL_DEV: undefined,
  };
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "unit" })
    .setIssuer("https://unit-team.example")
    .setAudience("unit-audience")
    .setExpirationTime("5m")
    .sign(privateKey);
  expect(await verifyAccess(token, settings)).toBe(true);
  expect(await verifyAccess("bad", settings)).toBe(false);
  expect(await verifyAccess(token, env)).toBe(false);
  expect(
    (
      await app.fetch(
        new Request("https://example.org/app/private", {
          headers: { "Cf-Access-Jwt-Assertion": token },
        }),
        settings,
      )
    ).status,
  ).toBe(200);
});
