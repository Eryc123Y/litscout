import { readFileSync } from "node:fs";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { loadServerConfig, workerOptions } from "./config";
import { lockState } from "./lock";
import { nextDailyRun } from "./schedule";
import {
  importKv,
  plainTables,
  runImport,
  tableCounts,
  type KvEntry,
} from "./import";
import type { SchemaRow } from "./import-plan";
import { applyMigrations } from "./migrate";

const usage = `litscout-server: run LitScout's Worker on your own machine.

  serve   --config FILE               serve the web app, API and MCP (a trial
                                      applies new migrations first)
  migrate --config FILE [--dry-run]   apply new database migrations
  import  --config FILE --schema FILE --data FILE [--kv FILE]
                                      copy a D1 export into a new state folder
  counts  --config FILE               row counts of every table, as JSON

Stop "serve" before migrate, import or counts: they use the same data.`;

function flag(name: string) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
function required(name: string) {
  const value = flag(name);
  if (!value) throw new Error(`--${name} is required\n\n${usage}`);
  return value;
}

async function open(listen: boolean) {
  const { config, secrets } = loadServerConfig(required("config"));
  const release = lockState(config.state);
  const options = workerOptions(config, secrets);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      ...options,
      ...(listen ? {} : { port: 0 }),
      logRequests: false,
    }),
  );
  const url = await mf.ready;
  const close = async () => {
    await mf.dispose();
    release();
  };
  return { config, mf, url, close };
}

async function serve() {
  const { config, mf, url, close } = await open(true);
  // A trial on this computer prepares its own database: one step less for
  // someone trying LitScout. A server keeps migrate as a separate step, run
  // with the service stopped and a snapshot taken.
  if (config.local) {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const { applied } = await applyMigrations(
      db,
      path.join(config.app, "migrations"),
      {},
    );
    if (applied.length)
      console.log(`Database prepared (${applied.length} migrations applied)`);
  }
  console.log(`LitScout server on ${url.href} (data in ${config.state})`);
  const [hours, minutes] = config.cronUtc.split(":");
  const cron = `${Number(minutes)} ${Number(hours)} * * *`;
  let timer: NodeJS.Timeout | undefined;
  const plan = () => {
    const at = nextDailyRun(new Date(), config.cronUtc);
    timer = setTimeout(async () => {
      try {
        const worker = await mf.getWorker();
        const result = await worker.scheduled({ cron, scheduledTime: at });
        console.log(`Scheduled handler ${at.toISOString()}: ${result.outcome}`);
      } catch (error) {
        console.error("Scheduled handler failed", error);
      }
      plan();
    }, at.getTime() - Date.now());
  };
  plan();
  const stop = async () => {
    clearTimeout(timer);
    await close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function migrate() {
  const { config, mf, close } = await open(false);
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const result = await applyMigrations(
      db,
      path.join(config.app, "migrations"),
      {
        dryRun: process.argv.includes("--dry-run"),
      },
    );
    console.log(JSON.stringify(result));
  } finally {
    await close();
  }
}

/** sqlite_master rows from a file: a plain array or `wrangler d1 execute --json` output. */
function schemaRows(file: string): SchemaRow[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (Array.isArray(parsed) && parsed[0] && "results" in parsed[0])
    return (parsed[0] as { results: SchemaRow[] }).results;
  return parsed as SchemaRow[];
}

async function importCommand() {
  const rows = schemaRows(required("schema"));
  const data = readFileSync(required("data"), "utf8");
  const kvFile = flag("kv");
  const { mf, close } = await open(false);
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const result = await runImport(db, rows, data);
    const kv = kvFile
      ? await importKv(
          (await mf.getKVNamespace("OAUTH_KV")) as unknown as KVNamespace,
          JSON.parse(readFileSync(kvFile, "utf8")) as KvEntry[],
        )
      : 0;
    console.log(JSON.stringify({ ...result, kvKeys: kv }));
  } finally {
    await close();
  }
}

async function counts() {
  const { mf, close } = await open(false);
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    console.log(JSON.stringify(await tableCounts(db, await plainTables(db))));
  } finally {
    await close();
  }
}

const commands: Record<string, () => Promise<void>> = {
  serve,
  migrate,
  import: importCommand,
  counts,
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.log(usage);
  process.exit(process.argv[2] ? 1 : 0);
}
command().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
