import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { databaseHarness } from "./harness";
import { upsertPaper, upsertResolvedPaper } from "../src/papers";
import { addLibraryItem, editLibraryItem, listLibrary } from "../src/library";
import { readState, recordEvent } from "../src/library-state";
import { addNote, listNotes } from "../src/quick-notes";

it("preserves active saves, tags, notes and reading state when versions already exist", async () => {
  const { db, close } = await databaseHarness("sqlite");
  const day = "2026-11-18";
  const date = day + "T00:00:00.000Z";
  const preprint = { scheme: "arxiv", value: "2401.00010" };
  const published = { scheme: "doi", value: "10.1000/edition" };
  const data = {
    title: "The same work",
    authors: [{ name: "Ada Smith" }],
    year: 2026,
  };
  try {
    const old = await upsertPaper(
      db,
      { ...data, year: 2025, identifiers: [preprint] },
      0,
    );
    const newer = await upsertPaper(
      db,
      { ...data, venue: "TOG", identifiers: [published] },
      0,
    );
    if (!old.ok || !newer.ok)
      throw new Error("Both editions should exist before a bridge is known");
    for (const [id, tag] of [
      [old.value.id, "preprint"],
      [newer.value.id, "published"],
    ] as const) {
      await addLibraryItem(db, id, "web", day, date);
      await editLibraryItem(db, id, 1, date, { tags: [tag], if_rev: 1 });
    }
    await recordEvent(db, old.value.id, "open", day, date, "web");
    await recordEvent(db, newer.value.id, "rate_down", day, date, "mcp");
    await recordEvent(db, newer.value.id, "star", day, date, "mcp");
    await addNote(db, newer.value.id, "**Look up this method**", "web", date);
    const merged = await upsertResolvedPaper(db, {
      ...data,
      identifiers: [preprint, published],
    });
    if (!merged.ok)
      throw new Error("Identifier bridge should merge the editions");
    expect(await db.all(sql`SELECT id FROM papers`)).toEqual([
      { id: merged.value.id },
    ]);
    expect((await listLibrary(db, {})).items).toMatchObject([
      {
        paperId: merged.value.id,
        tags: ["preprint", "published"],
        readAt: date,
      },
    ]);
    expect((await readState(db, { day, limit: 100 })).items).toMatchObject([
      { paperId: merged.value.id, starred: true, rating: "down" },
    ]);
    expect(await listNotes(db, merged.value.id)).toMatchObject([
      { bodyMd: "**Look up this method**" },
    ]);
  } finally {
    await close();
  }
});
