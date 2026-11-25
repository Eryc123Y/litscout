import { expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../src/schema";
import { databaseHarness } from "./harness";
import { sql } from "drizzle-orm";
it("matches every Drizzle column, primary key and index to the SQL migration", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    for (const table of Object.values(schema).filter((t) =>
      is(t, SQLiteTable),
    )) {
      const config = getTableConfig(table);
      const actual = await db.all<{ name: string; pk: number }>(
        sql`PRAGMA table_xinfo(${sql.identifier(config.name)})`,
      );
      expect(actual.map((c) => c.name).sort()).toEqual(
        config.columns.map((c) => c.name).sort(),
      );
      expect(config.primaryKeys).toHaveLength(1);
      expect(
        actual
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name),
        `${config.name} primary key`,
      ).toEqual(config.primaryKeys[0]!.columns.map((c) => c.name));
      for (const fk of config.foreignKeys)
        expect(fk.reference().columns.length).toBe(1);
      const indexes = await db.all<{ name: string; origin: string }>(
        sql`PRAGMA index_list(${sql.identifier(config.name)})`,
      );
      expect(
        indexes
          .filter((i) => i.origin === "c")
          .map((i) => i.name)
          .sort(),
        `${config.name} indexes`,
      ).toEqual(config.indexes.map((i) => i.config.name).sort());
    }
  } finally {
    await close();
  }
});
