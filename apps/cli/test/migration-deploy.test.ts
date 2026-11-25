import { afterEach, expect, it, vi } from "vitest";
import SQLite from "better-sqlite3";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { migrationFiles } from "@litscout/db/test/harness";
import { runCommand } from "../src/setup-commands";

const migrationsDir = path.resolve("packages/db/migrations");
const day = "2026-11-18";
const name = "0017_write_cost.sql";
// Each of 0018–0027 adds 12 bookkeeping writes to its fixed allowance
// when the fixture's Wrangler response has no write metadata.
const budgetMigrationsCharge =
  3 * (12 + 12) +
  (6 + 12) +
  (4 + 12) +
  (160 + 1 + 12) +
  (64 + 12) +
  (4 + 12) +
  (4 + 12) +
  (2 + 12);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture({
  ids = 3066,
  links = 6530,
  used = 0,
  actual = 0,
  fresh = false,
} = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(day + "T04:00:00Z"));
  const db = new SQLite(":memory:");
  db.function("date", (_value: string) => day);
  cleanup.push(() => {
    db.close();
  });
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-migrations-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  if (!fresh) {
    db.exec(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    for (const file of migrationFiles.filter((file) => file < name)) {
      db.exec(await readFile(path.join(migrationsDir, file), "utf8"));
      db.prepare("INSERT INTO d1_migrations(name) VALUES (?)").run(file);
    }
    db.exec(`INSERT INTO papers(id,title,title_norm) VALUES ('p','Paper','paper');
      INSERT INTO write_leases(id,day,reserved,estimate,created_at)
        VALUES ('lease','${day}',1000,1000,'${day}T03:59:00.000Z');
      INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES ('${day}',${used},1000);
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${ids})
        INSERT INTO paper_ids SELECT 'p','doi','id-'||x FROM n;
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${links})
        INSERT INTO paper_links(id,paper_id,kind,url) SELECT 'link-'||x,'p','landing','url-'||x FROM n;`);
  }
  const out: string[] = [];
  let failBeforeMigration = false;
  let growBeforeMigration = false;
  let loseMigrationResponse = false;
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "whoami") return "Authenticated";
    if (args[0] === "d1" && args[1] === "list")
      return JSON.stringify([{ name: "sample-db", uuid: "synthetic" }]);
    if (args[0] === "d1" && args[1] === "execute") {
      const sql = args[args.indexOf("--command") + 1]!;
      if (
        /^\s*SELECT/i.test(sql) &&
        !sql.trim().replace(/;$/, "").includes(";")
      )
        return JSON.stringify([
          { success: true, results: db.prepare(sql).all() },
        ]);
      const isRebuild = sql.includes("CREATE TABLE m3i_paper_ids");
      if (isRebuild && failBeforeMigration) throw new Error("D1 offline");
      if (isRebuild && growBeforeMigration)
        db.exec("INSERT INTO paper_ids VALUES ('p','doi','concurrent')");
      db.transaction(() => db.exec(sql))();
      if (isRebuild && loseMigrationResponse)
        throw new Error("Response lost after commit");
      return JSON.stringify([
        {
          success: true,
          results: [],
          ...(isRebuild && actual ? { meta: { rows_written: actual } } : {}),
        },
      ]);
    }
    if (args[0] === "kv" && args.includes("create"))
      return '{"id":"namespace"}';
    if (args[0] === "kv" || args[0] === "secret") return "OK";
    if (args[0] === "deploy") return "https://sample.example";
    throw new Error("Unexpected Wrangler command");
  });
  const cmd = (args: string[]) =>
    runCommand(["deploy", "--skip-keys", "--json", ...args], {
      run,
      dir,
      cwd: dir,
      bundlePath: path.resolve("packages/db/worker.js"),
      templateDir: dir,
      isTTY: false,
      loadConfig: async () => defineConfig({ instance: { name: "sample" } }),
      fetch: vi.fn(),
      prompt: vi.fn(),
      fetchVenues: vi.fn(async () => ({ downloaded_at: day, venues: [] })),
      print: (message) => out.push(message),
    });
  return {
    db,
    dir,
    cmd,
    run,
    output: () => JSON.parse(out.at(-1)!).data,
    fail: () => {
      failBeforeMigration = true;
    },
    grow: () => {
      growBeforeMigration = true;
    },
    loseResponse: () => {
      loseMigrationResponse = true;
    },
  };
}

it("requires an estimate rule for every bundled SQL migration", async () => {
  const costs = JSON.parse(
    await readFile(path.join(migrationsDir, "costs.json"), "utf8"),
  );
  expect(Object.keys(costs).sort()).toEqual(migrationFiles);
});

it("lists only pending migrations and counts staging rows in a read-only preview", async () => {
  const h = await fixture();
  expect(await h.cmd(["--dry-run"])).toBe(0);
  expect(h.output().migrations).toContainEqual({
    name,
    estimatedRows: 25978,
  });
  expect(h.output().migrations).toContainEqual({
    name: "0022_derived_arxiv_links.sql",
    estimatedRows: 4,
  });
  expect(
    h.output().migrations.map((item: { name: string }) => item.name),
  ).not.toContain("0001_schema.sql");
  expect(h.output().remaining).toBe(78998);
  expect(await readdir(h.dir)).toEqual([]);
  expect(
    h.run.mock.calls.every(
      ([args]) =>
        args[1] === "list" ||
        /^\s*SELECT/i.test(args[args.indexOf("--command") + 1] ?? ""),
    ),
  ).toBe(true);
  expect(
    h.db
      .prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name=?")
      .get(name),
  ).toEqual({ n: 0 });
});

it("reports the days needed by the 30,000-paper rebuild and refuses before writing", async () => {
  const h = await fixture({ ids: 60000, links: 60000, used: 50000 });
  expect(await h.cmd(["--dry-run"])).toBe(0);
  expect(h.output().migrations).toContainEqual({ name, estimatedRows: 300256 });
  expect(await h.cmd([])).toBe(1);
  expect(h.output().message).toMatch(
    /300256[\s\S]*28998[\s\S]*2026-11-19T00:00:00.000Z[\s\S]*11 days/,
  );
  expect(
    h.db
      .prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name=?")
      .get(name),
  ).toEqual({ n: 0 });
});

it.each([0, 26000])(
  "precharges migrations and settles Wrangler rows (actual fixture: %s)",
  async (actual) => {
    const h = await fixture({ used: 60000, actual });
    expect(await h.cmd([])).toBe(1);
    expect(await h.cmd(["--allow-over-budget"])).toBe(0);
    expect(h.output().messages.join("\n")).toContain(name);
    const migration = h.db
      .prepare(
        "SELECT SUM(rows_written) AS n FROM migration_write_usage WHERE day=?",
      )
      .get(day) as { n: number };
    expect(migration.n).toBe(
      (actual ? actual + 2 : 25990) + budgetMigrationsCharge,
    );
    expect(
      h.db
        .prepare(
          "SELECT rows_written,reserved FROM daily_write_usage WHERE day=?",
        )
        .get(day),
    ).toEqual({ rows_written: 60000 + migration.n, reserved: 1000 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM paper_links").get()).toEqual(
      { n: 6530 },
    );
    expect(await h.cmd(["--allow-over-budget"])).toBe(0);
    expect(
      h.db
        .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
        .get(day),
    ).toEqual({ rows_written: 60000 + migration.n });
  },
);

it.each(["failure", "growth"])(
  "leaves a rebuild and its charge unapplied after %s",
  async (problem) => {
    const h = await fixture();
    if (problem === "failure") h.fail();
    else h.grow();
    expect(await h.cmd([])).toBe(1);
    expect(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name=?")
        .get(name),
    ).toEqual({ n: 0 });
    expect(
      h.db
        .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
        .get(day),
    ).toEqual({ rows_written: 0 });
    expect(h.run.mock.calls.some(([args]) => args[0] === "deploy")).toBe(false);
  },
);

it("keeps the estimated charge if Wrangler loses a committed response and never charges the migration again", async () => {
  const h = await fixture();
  h.loseResponse();
  expect(await h.cmd([])).toBe(1);
  expect(h.output().message).toContain(name);
  const usage = () =>
    h.db
      .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
      .get(day);
  expect(usage()).toEqual({ rows_written: 25990 });
  expect(await h.cmd([])).toBe(0);
  expect(usage()).toEqual({ rows_written: 25990 + budgetMigrationsCharge });
  expect(await h.cmd([])).toBe(0);
  expect(usage()).toEqual({ rows_written: 25990 + budgetMigrationsCharge });
});

it("reserves on an empty database and retains the bootstrap charges when the daily ledger is created", async () => {
  const h = await fixture({ fresh: true });
  expect(await h.cmd(["--dry-run"])).toBe(0);
  expect(
    h.output().migrations.map((item: { name: string }) => item.name),
  ).toEqual(migrationFiles);
  expect(h.db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()).toEqual(
    { n: 0 },
  );
  expect(await h.cmd([])).toBe(0);
  expect(h.db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").get()).toEqual(
    { n: migrationFiles.length },
  );
  const migration = h.db
    .prepare(
      "SELECT SUM(rows_written) AS n FROM migration_write_usage WHERE day=?",
    )
    .get(day) as { n: number };
  expect(migration.n).toBeGreaterThan(0);
  expect(
    h.db
      .prepare("SELECT rows_written FROM daily_write_usage WHERE day=?")
      .get(day),
  ).toEqual({ rows_written: migration.n });
});

it("uses the reduced cap and omits expired lease overhead after the budget upgrade", async () => {
  const h = await fixture();
  expect(await h.cmd([])).toBe(0);
  h.db.exec(`UPDATE write_leases SET expired=1;
    UPDATE daily_write_usage SET rows_written=74000,reserved=0,unaccounted=15 WHERE day='${day}';`);
  expect(await h.cmd(["--dry-run"])).toBe(0);
  expect(h.output().commands.join("\n")).toContain("1000 remain today");
});
