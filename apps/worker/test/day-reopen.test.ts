import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

const day = "2026-11-18";
const emptyDay = "2026-11-19";
const path = `/api/v1/days/${day}/reopen`;
const tokens = {
  read: "lsk_" + "R".repeat(52),
  write: "lsk_" + "W".repeat(52),
};
let db: D1Database;
let close: () => Promise<void>;
const storedDay = (date = day) =>
  db.prepare("SELECT status,rev FROM feed_days WHERE day=?").bind(date).first();
const digests = () =>
  db
    .prepare("SELECT day,lang,kind,body_md FROM digests ORDER BY day,kind,lang")
    .all()
    .then((r) => r.results);
const call = (route: string, scope: keyof typeof tokens = "write") =>
  app.request(
    route,
    {
      method: "POST",
      headers: { authorization: "Bearer " + tokens[scope] },
    },
    { ...workerEnv().env, DB: db, LOCAL_DEV: "true" },
  );

beforeAll(async () => {
  const harness = await databaseHarness("d1");
  close = harness.close;
  db = harness.db.$client as unknown as D1Database;
  await db.batch([
    ...Object.entries(tokens).map(([scope, token]) =>
      db
        .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
        .bind(
          "tok_" + scope,
          scope,
          createHash("sha256").update(token).digest("hex"),
          JSON.stringify([scope]),
        ),
    ),
    db
      .prepare(
        "INSERT INTO feed_days(day,status,rev) VALUES (?, 'final', 9), (?, 'digested', 2)",
      )
      .bind(day, emptyDay),
    db.prepare(
      "INSERT INTO papers(id,title,title_norm) VALUES ('pap_venue','Venue paper','venue paper')",
    ),
    db
      .prepare(
        "INSERT INTO feed_items(day,paper_id,source) VALUES (?,'pap_venue','venue')",
      )
      .bind(day),
    db.prepare(
      "INSERT INTO summaries(paper_id,content) VALUES ('pap_venue','{}')",
    ),
    db.prepare(
      "INSERT INTO notes(id,target_type,target_id,body_md,origin) VALUES ('note_1','paper','pap_venue','Keep me','quick')",
    ),
    db.prepare(
      "INSERT INTO library_items(paper_id,added_via) VALUES ('pap_venue','cli')",
    ),
    ...[
      [day, "en", "daily", "Early English digest"],
      [day, "zh", "daily", "Early Chinese digest"],
      [day, "en", "weekly", "Keep the weekly report"],
      [emptyDay, "en", "daily", "Different day"],
    ].map((values) =>
      db
        .prepare("INSERT INTO digests(day,lang,kind,body_md) VALUES (?,?,?,?)")
        .bind(...values),
    ),
  ]);
});
afterAll(async () => close?.());

it("requires write scope for both preview and apply and rejects cross-origin cookie writes", async () => {
  expect((await call(path, "read")).status).toBe(403);
  expect((await call(path + "?dryRun=1", "read")).status).toBe(403);
  const blocked = await app.request(
    path,
    {
      method: "POST",
      headers: {
        origin: "https://other.example",
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
    },
    { ...workerEnv().env, DB: db, LOCAL_DEV: "true" },
  );
  expect(blocked.status).toBe(403);
  expect(await storedDay()).toEqual({ status: "final", rev: 9 });
});

it("previews without writes, reopens both languages atomically and preserves other records", async () => {
  const before = await digests();
  const plan = {
    day,
    oldStatus: "final",
    newStatus: "crawled",
    digests: [{ lang: "en" }, { lang: "zh" }],
    changed: true,
  };
  const snapshot = () =>
    db
      .batch([
        ...["papers", "feed_items", "summaries", "notes", "library_items"].map(
          (table) => db.prepare(`SELECT * FROM ${table}`),
        ),
      ])
      .then((rows) => rows.map((row) => row.results));
  const keep = await snapshot();
  const preview = await call(path + "?dryRun=1");
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    data: { ...plan, dryRun: true },
    meta: { rowsWritten: 0 },
  });
  expect(await digests()).toEqual(before);
  expect(await storedDay()).toEqual({ status: "final", rev: 9 });
  expect(
    await db
      .prepare("SELECT last_used_at FROM api_tokens WHERE id='tok_write'")
      .first(),
  ).toEqual({
    last_used_at: null,
  });
  expect(
    await db.prepare("SELECT * FROM daily_write_usage").all(),
  ).toMatchObject({ results: [] });

  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const applied = await call(path);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      data: { ...plan, dryRun: false },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({
      event: "day.reopen",
      day,
      oldStatus: "final",
      newStatus: "crawled",
    });
    expect(await storedDay()).toEqual({ status: "crawled", rev: 10 });
    expect(await digests()).toEqual(
      before.filter((d) => d.day !== day || d.kind === "weekly"),
    );
    expect(await snapshot()).toEqual(keep);

    const retry = await call(path);
    expect(await retry.json()).toMatchObject({
      data: {
        day,
        oldStatus: "crawled",
        newStatus: "crawled",
        digests: [],
        changed: false,
      },
      meta: { rowsWritten: 0 },
    });
    expect(await storedDay()).toEqual({ status: "crawled", rev: 10 });
  } finally {
    log.mockRestore();
  }
});

it("resets a closed day with no feed items to pending", async () => {
  const response = await call(`/api/v1/days/${emptyDay}/reopen`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { oldStatus: "digested", newStatus: "pending", changed: true },
  });
  expect(await storedDay(emptyDay)).toEqual({ status: "pending", rev: 3 });
});
