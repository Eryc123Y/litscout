import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

// The own server reports its facts after each run; Health and the private
// health details (read by `doctor`) show them with the runtime.
let harness: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
const bindings = (runtime?: string) => ({
  ...workerEnv().env,
  DB: db,
  LOCAL_DEV: "true",
  ...(runtime && { LITSCOUT_RUNTIME: runtime }),
});
const status = {
  checkedAt: "2026-11-22T13:50:00Z",
  footprintBytes: 2_800_000_000,
  warningBytes: 4 * 1024 ** 3,
  capBytes: 5 * 1024 ** 3,
  snapshot: { at: "2026-11-22T12:38:05Z", bytes: 6_800_000 },
  runs: [
    { mode: "main", startedAt: "2026-11-22T01:45:00Z", failed: false },
    { mode: "final", startedAt: "2026-11-22T13:45:00Z", failed: true },
  ],
};
const put = (body: unknown, env = bindings("server")) =>
  app.request(
    "https://worker.example/api/v1/ingest/server-status",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
// The private health details need a token, even in local development;
// Health itself is open to the local reader.
const get = async (path: string, env = bindings("server")) =>
  (
    await app.request(
      "https://worker.example" + path,
      path === "/api/v1/health"
        ? { headers: { authorization: "Bearer " + readToken } }
        : {},
      env,
    )
  ).json<{ data: Record<string, unknown> }>();

const readToken = "lsk_" + "R".repeat(52);
const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

beforeAll(async () => {
  harness = await databaseHarness("d1");
  db = harness.db.$client as D1Database;
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_read','read',?,'[\"read\"]')",
    )
    .bind(await sha256(readToken))
    .run();
});
afterAll(async () => harness?.close());

it("says where it runs, with no server facts before the first report", async () => {
  expect(
    (await get("/api/v1/operations/health", bindings())).data,
  ).toMatchObject({
    runtime: "cloudflare",
    server: null,
  });
  expect((await get("/api/v1/health")).data).toMatchObject({
    runtime: "server",
    server: null,
  });
});

it("stores the newest report and shows it in Health and the health details", async () => {
  expect((await put(status)).status).toBe(200);
  expect((await get("/api/v1/operations/health")).data).toMatchObject({
    runtime: "server",
    server: status,
  });
  const newer = { ...status, checkedAt: "2026-11-23T01:50:00Z", runs: [] };
  expect((await put(newer)).status).toBe(200);
  expect((await get("/api/v1/health")).data).toMatchObject({ server: newer });
});

it("rejects a report that does not match the contract", async () => {
  expect((await put({ ...status, footprintBytes: -1 })).status).toBe(400);
  expect((await put({ ...status, extra: true })).status).toBe(400);
  expect(
    (
      await put({
        ...status,
        runs: [{ mode: "weekly", startedAt: status.checkedAt, failed: false }],
      })
    ).status,
  ).toBe(400);
});
