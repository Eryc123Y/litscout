import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { VaultNote } from "@litscout/pipeline/vault-contracts";
import { databaseHarness } from "./harness";
import { recordEvent } from "../src/library-state";
import { addNote } from "../src/quick-notes";
import { createVaultRequest } from "../src/vault-requests";
import { publishVaultIndex, stageVaultIndex } from "../src/vault-index";
import type { Database } from "../src/database";

// A double click or a client retry must not write the same thing twice
// (independent review of 2026-11-20).
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 20, 8, minute)).toISOString();
let db: Database, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await databaseHarness("d1"));
  await db.run(
    sql`INSERT INTO papers(id,title,title_norm,source) VALUES ('pap_a','A paper','a paper','arxiv')`,
  );
});
afterEach(async () => close());
const count = async (table: "events" | "notes", where = sql`1=1`) =>
  (
    await db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM ${sql.raw(table)} WHERE ${where}`,
    )
  ).n;

it("records an open once a day and a star or rating only when it changes", async () => {
  const event = (kind: never, day: string, minute: number) =>
    recordEvent(db, "pap_a", kind, day, at(minute), "web");
  await event("open" as never, "2026-11-20", 0);
  await event("open" as never, "2026-11-20", 1);
  expect(await count("events", sql`kind='open'`)).toBe(1);
  await event("open" as never, "2026-11-21", 2);
  expect(await count("events", sql`kind='open'`)).toBe(2);

  await event("star" as never, "2026-11-20", 3);
  await event("star" as never, "2026-11-20", 4);
  expect(await count("events", sql`kind='star'`)).toBe(1);
  await event("unstar" as never, "2026-11-20", 5);
  await event("unstar" as never, "2026-11-20", 6);
  expect(await count("events", sql`kind='unstar'`)).toBe(1);

  await event("rate_up" as never, "2026-11-20", 7);
  const state = await event("rate_up" as never, "2026-11-20", 8);
  expect(await count("events", sql`kind='rate_up'`)).toBe(1);
  expect(state).toMatchObject({ rating: "up", starred: false });
  await event("rate_down" as never, "2026-11-20", 9);
  expect(await count("events", sql`kind like 'rate_%'`)).toBe(2);
});

it("returns the same note when the same text is added again within a minute", async () => {
  const first = await addNote(db, "pap_a", "Read §3", "web", at(0));
  const retry = await addNote(db, "pap_a", "Read §3", "web", at(0));
  expect(retry?.id).toBe(first?.id);
  expect(await count("notes")).toBe(1);
  const later = await addNote(db, "pap_a", "Read §3", "web", at(5));
  expect(later?.id).not.toBe(first?.id);
  expect(await count("notes")).toBe(2);
});

it("returns the queued request when a capture or an idea change is sent again", async () => {
  const capture = { kind: "capture", title: "Stereo idea", body: "Try it" };
  const first = await createVaultRequest(db, capture as never, at(0), "web");
  const retry = await createVaultRequest(db, capture as never, at(1), "web");
  expect(retry.id).toBe(first.id);
  const other = await createVaultRequest(
    db,
    { ...capture, title: "Another idea" } as never,
    at(1),
    "web",
  );
  expect(other.id).not.toBe(first.id);

  const idea = {
    path: "Idea.md",
    title: "Stereo idea",
    id: h("Idea.md"),
    hash: h("Stereo idea"),
    bodyHash: h("body"),
    kind: "idea",
    frontmatter: { status: "seed" },
  } satisfies VaultNote;
  const start = { snapshot: h("snapshot"), previous: null };
  await stageVaultIndex(db, { ...start, part: 0, notes: [idea] });
  await publishVaultIndex(
    db,
    { ...start, parts: 1, count: 1, changes: 1 },
    at(0),
  );
  const status = {
    kind: "set_status",
    targetNoteId: idea.id,
    status: "exploring",
  };
  const queued = await createVaultRequest(db, status as never, at(2), "mcp");
  const again = await createVaultRequest(db, status as never, at(3), "mcp");
  expect(again).toMatchObject({ id: queued.id, state: "queued" });
  // A different status for the same idea is a new change, not a retry: it
  // must not be reported as queued when only the first one is.
  await expect(
    createVaultRequest(
      db,
      { ...status, status: "parked" } as never,
      at(4),
      "mcp",
    ),
  ).rejects.toThrow(/already queued/);
});
