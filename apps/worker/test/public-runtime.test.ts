import { beforeAll, afterAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { webRuntime } from "./helpers/web-runtime";
let runtime: Miniflare;
beforeAll(async () => {
  runtime = await webRuntime({ localDev: false });
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
});
it("public reads work without Access, use explicit nested fields, and keep private APIs protected", async () => {
  for (const path of [
    "/api/v1/public/days",
    "/api/v1/public/days/2026-11-17",
  ]) {
    const response = await runtime.dispatchFetch("http://local" + path);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(
      /PRIVATE_|"(?:bodyMd|radar|profile|rating|notes|library|ideas|userId|client|model)":/,
    );
  }
  expect(
    (await runtime.dispatchFetch("http://local/api/v1/feed/days")).status,
  ).toBe(503);
  expect(
    (await runtime.dispatchFetch("http://local/api/v1/public/days/bad")).status,
  ).toBe(400);
  expect(
    (await runtime.dispatchFetch("http://local/api/v1/public/days?limit=999"))
      .status,
  ).toBe(400);
  expect(
    (await runtime.dispatchFetch("http://local/api/v1/public/operations"))
      .status,
  ).toBe(404);
  expect(
    (
      await runtime.dispatchFetch("http://local/api/v1/public/days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(503);
});
it("shows cursor-confirmed no-announcement dates without manufacturing pending batches", async () => {
  const db = await runtime.getD1Database("DB");
  await db
    .prepare("INSERT INTO sync_cursors(name,value) VALUES ('arxiv-listing',?)")
    .bind(
      JSON.stringify({
        listingDate: "2026-11-17",
        runDay: "2026-11-17",
        noAnnouncement: ["2026-11-13"],
      }),
    )
    .run();
  const day = await runtime.dispatchFetch(
    "http://local/api/v1/public/days/2026-11-13",
  );
  expect(await day.json()).toMatchObject({
    data: { status: "empty", items: [] },
  });
  const days = await runtime.dispatchFetch(
    "http://local/api/v1/public/days?before=2026-11-14",
  );
  expect(await days.json()).toMatchObject({
    data: [{ day: "2026-11-13", status: "empty" }],
  });
});
it("exercises source handlers and malformed cursor fallback with a real local D1", async () => {
  const { app } = await import("../src/app");
  const { workerEnv } = await import("./helpers/worker-env");
  const db = await runtime.getD1Database("DB"),
    env = {
      ...workerEnv().env,
      DB: db,
      LOCAL_DEV: "true",
      PUBLIC_FEED: "true",
    };
  for (const path of [
    "/api/v1/public/days",
    "/api/v1/public/days/2026-11-13",
    "/api/v1/feed/days?limit=1&before=2026-11-17",
    "/api/v1/feed/days/2026-11-13",
  ]) {
    expect((await app.request(path, {}, env)).status).toBe(200);
  }
  for (const value of [
    '{"invalid":"PRIVATE"}',
    "not-json",
    '{"listingDate":"2026-11-17","runDay":"2026-11-17"}',
  ]) {
    await db
      .prepare("UPDATE sync_cursors SET value=? WHERE name='arxiv-listing'")
      .bind(value)
      .run();
    const response = await app.request(
      "/api/v1/public/days/2026-11-13",
      {},
      env,
    );
    expect(await response.json()).toMatchObject({
      data: { status: "pending" },
    });
  }
  expect((await app.request("/api/v1/public/days/bad", {}, env)).status).toBe(
    400,
  );
});
it("counts papers in journal-only days even when source-specific count keys are private to the backend", async () => {
  const { app } = await import("../src/app");
  const { workerEnv } = await import("./helpers/worker-env");
  const db = await runtime.getD1Database("DB");
  await db
    .prepare("UPDATE feed_days SET counts=? WHERE day='2026-11-17'")
    .bind('{"crossref":3,"PRIVATE_COUNT":999}')
    .run();
  const response = await app.request(
    "/api/v1/public/days?before=2026-11-18",
    {},
    { ...workerEnv().env, DB: db, PUBLIC_FEED: "true" },
  );
  const body = (await response.json()) as {
    data: { day: string; counts: { total: number } }[];
  };
  expect(body.data.find((d) => d.day === "2026-11-17")?.counts.total).toBe(3);
  expect(JSON.stringify(body)).not.toContain("PRIVATE");
});

it("P4 returns generic public validation errors and keeps private field details", async () => {
  const { app } = await import("../src/app");
  const { workerEnv } = await import("./helpers/worker-env");
  const db = await runtime.getD1Database("DB");
  const env = {
    ...workerEnv().env,
    DB: db,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
  };
  for (const path of [
    "/api/v1/public/days?limit=0&before=bad",
    "/api/v1/public/days/not-a-date",
  ]) {
    const response = await app.request(path, {}, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid input" },
    });
  }
  const response = await app.request("/api/v1/feed/days/not-a-date", {}, env);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { fields: expect.any(Array) },
  });
});
it("P2 applies the same 60-read budget in actual workerd without double counting", async () => {
  const headers = { "CF-Connecting-IP": "192.0.2.60" };
  for (let i = 0; i < 60; i++)
    expect(
      (
        await runtime.dispatchFetch("http://local/api/v1/public/days", {
          headers,
        })
      ).status,
    ).toBe(200);
  const response = await runtime.dispatchFetch(
    "http://local/api/v1/public/days/2026-11-17",
    { headers },
  );
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(
    (
      await runtime.dispatchFetch("http://local/api/v1/public/days", {
        headers: { "CF-Connecting-IP": "192.0.2.61" },
      })
    ).status,
  ).toBe(200);
});
