import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { VaultNote } from "@litscout/pipeline/vault-contracts";
import { databaseHarness } from "./harness";
import { publishVaultIndex, stageVaultIndex } from "../src/vault-index";
import { vaultNoteById } from "../src/vault-reads";
import { restoreBackupPage } from "../src/backup-restore";
import type { Database } from "../src/database";

// Project, idea and draft bodies uploaded with vault.uploadBodies are read
// back for the web; a later index without the body clears it.
const h = (value: string) => createHash("sha256").update(value).digest("hex");
let db: Database, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await databaseHarness("d1"));
});
afterEach(async () => close());
const project = (body?: string) =>
  ({
    path: "Projects/Stereo.md",
    title: "Stereo",
    id: h("Projects/Stereo.md"),
    hash: h("text" + (body ?? "")),
    bodyHash: h(body ?? ""),
    kind: "project",
    ...(body ? { body } : {}),
    frontmatter: { status: "active" },
  }) satisfies VaultNote;
async function publish(note: VaultNote, previous: string | null, n: number) {
  const snapshot = h("snapshot " + n);
  await stageVaultIndex(db, { snapshot, previous, part: 0, notes: [note] });
  await publishVaultIndex(
    db,
    { snapshot, previous, parts: 1, count: 1, changes: 1 },
    "2026-11-20T13:00:00.000Z",
  );
  return snapshot;
}

it("stores an uploaded body and reads the note back for the web", async () => {
  const first = await publish(project("# Plan\n\nRead me"), null, 1);
  expect(await vaultNoteById(db, h("Projects/Stereo.md"))).toMatchObject({
    id: h("Projects/Stereo.md"),
    kind: "project",
    title: "Stereo",
    path: "Projects/Stereo.md",
    bodyMd: "# Plan\n\nRead me",
  });
  await publish(project(), first, 2);
  expect(await vaultNoteById(db, h("Projects/Stereo.md"))).toMatchObject({
    bodyMd: null,
  });
  expect(await vaultNoteById(db, h("missing"))).toBeNull();
});

it("drops the body when a note leaves the index", async () => {
  const first = await publish(project("Private plan"), null, 1);
  const snapshot = h("snapshot removal");
  const removal = { snapshot, previous: first };
  await stageVaultIndex(db, {
    ...removal,
    part: 0,
    notes: [],
    removed: [h("Projects/Stereo.md")],
  });
  await publishVaultIndex(
    db,
    { ...removal, parts: 1, count: 0, changes: 1 },
    "2026-11-20T14:00:00.000Z",
  );
  expect(
    await db.get(
      sql`SELECT deleted_at IS NOT NULL AS removed, body_md FROM vault_notes`,
    ),
  ).toEqual({ removed: 1, body_md: null });
});

it("restores project, idea and draft rows so the next sync uploads their bodies", async () => {
  const row = (kind: string, path: string) => ({
    id: h(path),
    path,
    kind,
    title: path,
    frontmatter: {},
    hash: h("text"),
    body_hash: h("body"),
    fingerprint: "fingerprint " + path,
    synced_at: "2026-11-20T13:00:00.000Z",
  });
  const client = db.$client as unknown as D1Database;
  await restoreBackupPage(client, {
    section: "vaultIndex",
    items: [
      row("project", "Plan.md"),
      row("idea", "Idea.md"),
      row("working_paper", "Draft.md"),
      row("paper_note", "Paper.md"),
    ],
  });
  expect(
    await db.all(sql`SELECT path, fingerprint FROM vault_notes ORDER BY path`),
  ).toEqual([
    { path: "Draft.md", fingerprint: "" },
    { path: "Idea.md", fingerprint: "" },
    { path: "Paper.md", fingerprint: "fingerprint Paper.md" },
    { path: "Plan.md", fingerprint: "" },
  ]);
});
