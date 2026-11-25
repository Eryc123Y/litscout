import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { databaseHarness } from "./harness";
import { upsertPaper, putSummary, searchPapers } from "../src/index";
for (const backend of ["sqlite", "d1"] as const)
  it(`uses compact FTS and supports multiple title/TLDR words in ${backend}`, async () => {
    const { db, close } = await databaseHarness(backend);
    try {
      const definitions = await db.all<{ sql: string }>(
        sql`SELECT sql FROM sqlite_master WHERE name IN ('paper_fts','note_fts','idea_fts')`,
      );
      expect(definitions).toHaveLength(3);
      for (const row of definitions) {
        expect(row.sql).toContain("detail=column");
        expect(row.sql).toContain("columnsize=0");
      }
      const p = await upsertPaper(
        db,
        { title: "Blue camera paper", abstract: "Unindexedquasar" },
        0,
      );
      if (!p.ok) throw Error("setup");
      await putSummary(
        db,
        {
          paperId: p.value.id,
          content: {
            tldr: "Binary seagulls",
            motivation: "",
            method: "",
            result: "",
            conclusion: "",
          },
        },
        0,
      );
      expect(await searchPapers(db, "Blue camera")).toHaveLength(1);
      expect(await searchPapers(db, "Binary seagulls")).toHaveLength(1);
      expect(await searchPapers(db, 'Blue " camera')).toHaveLength(1);
      expect(await searchPapers(db, "!!!")).toEqual([]);
      expect(await searchPapers(db, "Unindexedquasar")).toEqual([]);
    } finally {
      await close();
    }
  });
