import { beforeAll, afterAll, it, expect } from "vitest";
import { securityWorker } from "./helpers/security-worker";
let local: Awaited<ReturnType<typeof securityWorker>>;
beforeAll(async () => {
  local = await securityWorker();
});
afterAll(async () => {
  await local?.worker.dispose();
});
it("S6 only exposes known operational cursor names and rejects raw private cursor payloads", async () => {
  await local.db
    .prepare(
      "INSERT INTO sync_cursors(name,value) VALUES ('legacy:project-brief.md','SYNTHETIC_PRIVATE_DATA')",
    )
    .run();
  for (const name of [
    "legacy:project-brief.md",
    "legacy:feedback.md",
    "anything",
    "fulltext:invalid",
  ]) {
    const response = await local.call(
      "/sync/cursors?name=" + encodeURIComponent(name),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE_DATA");
  }
  expect(
    (
      await local.call("/ingest/legacy", "POST", {
        cursors: [{ name: "venue-feed", value: '{"since":"2026-11-17"}' }],
      })
    ).status,
  ).toBe(200);
  expect(
    await (await local.call("/sync/cursors?name=venue-feed")).json(),
  ).toMatchObject({ data: { name: "venue-feed" } });
  expect(
    (
      await local.call("/ingest/legacy", "POST", {
        cursors: [
          { name: "venue-feed", value: '{"private":"SYNTHETIC_PRIVATE_DATA"}' },
        ],
      })
    ).status,
  ).toBe(200);
  expect(
    await local.db
      .prepare("SELECT value FROM sync_cursors WHERE name='venue-feed'")
      .first("value"),
  ).toBe('{"since":"2026-11-17"}');
});

it("round-trips deferred arXiv dates while keeping the cursor allowlist bounded", async () => {
  const name = "arxiv-listing";
  const cursor = {
    listingDate: "2026-11-17",
    runDay: "2026-11-17",
    pendingDays: ["2026-11-16"],
  };
  const value = JSON.stringify(cursor);
  expect(
    (await local.call("/ingest/legacy", "POST", { cursors: [{ name, value }] }))
      .status,
  ).toBe(200);
  const read = () => local.call(`/sync/cursors?name=${name}`);
  const saved = await read();
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ data: { name, value } });
  await local.db
    .prepare("UPDATE sync_cursors SET value=? WHERE name=?")
    .bind(
      JSON.stringify({ ...cursor, pendingDays: ["SYNTHETIC_PRIVATE_DATA"] }),
      name,
    )
    .run();
  const invalid = await read();
  expect(invalid.status).toBe(404);
  expect(await invalid.text()).not.toContain("SYNTHETIC_PRIVATE_DATA");
});
