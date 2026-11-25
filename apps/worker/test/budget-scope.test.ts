import { afterAll, beforeAll, expect, it } from "vitest";
import { securityWorker } from "./helpers/security-worker";
let local: Awaited<ReturnType<typeof securityWorker>>;
beforeAll(async () => {
  local = await securityWorker();
});
afterAll(async () => {
  await local.worker.dispose();
});
it("R2 ingest-scoped tokens can read the authoritative budget; read-only tokens cannot", async () => {
  expect((await local.call("/budget", "GET", undefined, "ingest")).status).toBe(
    200,
  );
  expect((await local.call("/budget", "GET", undefined, "read")).status).toBe(
    403,
  );
});

it("keeps readiness probes read-only, including expired write leases", async () => {
  const { reserveWriteBudget } = await import("@litscout/db/write-budget");
  const past = new Date(Date.now() - 15 * 60_000);
  const lease = await reserveWriteBudget(local.db, 10, past, 8);
  expect(lease).not.toBeNull();
  await local.db
    .prepare("UPDATE api_tokens SET last_used_at = NULL WHERE id = 'tok_read'")
    .run();
  expect((await local.call("/vault/health")).status).toBe(200);
  const token = await local.db
    .prepare("SELECT last_used_at FROM api_tokens WHERE id = 'tok_read'")
    .first();
  expect(token?.last_used_at).toBeNull();

  const preview = await local.call("/vault/budget", "GET", undefined, "vault");
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    data: { staleLeasesReleased: 0 },
  });
  const normal = await local.call("/budget", "GET", undefined, "ingest");
  expect(await normal.json()).toMatchObject({
    data: { staleLeasesReleased: 1 },
  });
  expect((await local.call("/vault/budget")).status).toBe(403);
});

it("reports the instance's write limit from WRITE_LIMIT", async () => {
  const own = await securityWorker({ bindings: { WRITE_LIMIT: "1000000" } });
  try {
    const response = await own.call("/budget", "GET", undefined, "ingest");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { limit: 1_000_000, baseLimit: 1_000_000 },
    });
  } finally {
    await own.worker.dispose();
  }
});
