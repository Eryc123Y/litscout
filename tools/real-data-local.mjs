// Local only: an empty local Worker seeded with real legacy days, read
// read-only from the old pipeline's repository, for checking the reader with
// real data. Nothing leaves the machine: the CLI runs with the rehearsal
// preload, which allows only the local Worker. Databases and certificates
// live in a temporary directory removed on exit.
//
//   pnpm build
//   node --import tsx tools/real-data-local.mjs --from 2026-11-16 --to 2026-11-18 \
//     [--dir "<vault>/Claude/Scheduled/litscout-daily"]
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { webRuntime } from "../apps/worker/test/helpers/web-runtime.ts";
import {
  certificate,
  cliEntry,
  createToken,
  exec,
  root,
  setupCli,
} from "./rehearsal/setup.mjs";

const day = /^\d{4}-\d{2}-\d{2}$/;
export function realDataOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      repo: {
        type: "string",
        default: path.join(homedir(), "GitHub", "litscout-daily"),
      },
      port: { type: "string", default: "4175" },
      // The old pipeline's digest folder (read only), for digests and radar.
      dir: { type: "string" },
    },
    strict: true,
  });
  if (!day.test(values.from ?? "") || !day.test(values.to ?? ""))
    throw new Error("Use --from YYYY-MM-DD --to YYYY-MM-DD");
  if (values.from > values.to) throw new Error("--from must not follow --to");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("--port must be between 1024 and 65535");
  return { ...values, port };
}

/** The clock the CLI sees: noon UTC on the day after the window. */
export function importClock(to) {
  const next = new Date(Date.parse(to + "T12:00:00Z") + 86_400_000);
  return next.toISOString();
}

async function main() {
  const options = realDataOptions(process.argv.slice(2));
  const directory = await mkdtemp(
    path.join(await realpath(tmpdir()), "litscout-real-data-"),
  );
  let runtime;
  const stop = async () => {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const tls = await certificate(directory);
    runtime = await webRuntime({
      empty: {
        scriptPath: path.join(root, "apps/worker/dist/bundle/worker.js"),
      },
      assets: path.join(root, "apps/web/dist"),
      localDev: true,
      publicLimitOff: true,
      backupCooldownOff: true,
      port: options.port,
      tls,
    });
    const worker = (await runtime.ready).origin;
    const token = await createToken(await runtime.getD1Database("DB"));
    // No source fixtures are needed: the import reads only the repository.
    const cli = await setupCli(directory, worker, worker, tls.ca, token);
    const { stdout } = await exec(
      process.execPath,
      [
        cliEntry,
        "legacy",
        "import",
        "--repo",
        options.repo,
        "--from",
        options.from,
        "--to",
        options.to,
        ...(options.dir ? ["--dir", options.dir] : []),
        "--json",
        "--config",
        cli.config,
      ],
      {
        cwd: directory,
        env: { ...cli.env, LITSCOUT_REHEARSAL_NOW: importClock(options.to) },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600_000,
      },
    );
    const result = JSON.parse(stdout);
    process.stdout.write(
      JSON.stringify({
        worker,
        status: result.data?.status ?? result.status,
        counts: result.data?.counts ?? result.counts,
      }) + "\n",
    );
    process.stdout.write(
      `Real-data Worker ready: ${worker} (self-signed certificate; outbound network disabled)\n`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void stop().then(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
