import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
let db: D1Database, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  db = h.db.$client as unknown as D1Database;
  close = h.close;
});
afterAll(async () => close());
it("F5 handler 5xx charges the reserved cost and leaves no leaked reservation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const broken = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.includes('INSERT INTO "papers"'))
            throw new Error("synthetic write failure");
          return target.prepare(sql);
        };
      if (key === "batch") return target.batch.bind(target);
      return Reflect.get(target, key);
    },
  });
  try {
    const response = await app.request(
      "/api/v1/ingest/papers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day: "2026-11-17",
          papers: [
            {
              key: "one",
              title: "T",
              source: "test",
              identifiers: [{ scheme: "doi", value: "10.1234/test" }],
            },
          ],
        }),
      },
      { DB: broken, LOCAL_DEV: "true" },
    );
    expect(response.status).toBe(500);
    expect(
      await db.prepare("SELECT count(*) AS n FROM papers").first(),
    ).toEqual({ n: 0 });
    const budget = await app.request(
      "/api/v1/budget",
      {},
      { DB: db, LOCAL_DEV: "true" },
    );
    expect(await budget.json()).toMatchObject({
      // 64 + 3 identifier + 2 reserved payload rows, 1 usage-row creation, and
      // 2 reservation + 2 settlement accounting rows. No payload write ran.
      data: { reserved: 0, used: 74, staleLeasesReleased: 0, limit: 80000 },
    });
    expect(
      (await db.prepare("SELECT * FROM write_leases").all()).results,
    ).toHaveLength(0);
  } finally {
    warn.mockRestore();
  }
});
