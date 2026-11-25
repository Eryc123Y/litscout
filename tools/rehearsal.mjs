// Run with node --import tsx so the existing Worker fixture helper can be loaded.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { webRuntime } from "../apps/worker/test/helpers/web-runtime.ts";
import {
  legacyDay,
  monday,
  mondayPaper,
  startFixtures,
  thursday,
  tuesday,
  tuesdayPaper,
  venueTitle,
  wednesday,
} from "./rehearsal/fixtures.mjs";
import {
  certificate,
  cliEntry,
  createToken,
  exec,
  ideaText,
  legacyRepository,
  legacyTitle,
  root,
  setupCli,
} from "./rehearsal/setup.mjs";

const transcript = path.join(root, ".artifacts", "rehearsal.json");
const started = performance.now();
const report = { status: "running", steps: [], totalMs: 0 };
const msSince = (at) => Math.round(performance.now() - at);

async function saveReport() {
  report.totalMs = msSince(started);
  await writeFile(transcript, JSON.stringify(report, null, 2) + "\n");
}
async function step(name, run) {
  const timing = performance.now();
  const entry = { name, status: "running" };
  report.steps.push(entry);
  try {
    const result = await run(entry);
    entry.status = "passed";
    return result;
  } catch (error) {
    entry.status = "failed";
    entry.error = String(error);
    throw new Error(name + " failed", { cause: error });
  } finally {
    entry.elapsedMs = msSince(timing);
    await saveReport();
    process.stdout.write(`${entry.status} ${name} (${entry.elapsedMs} ms)\n`);
  }
}

function response(url, ca, headers) {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { ca, headers, signal: AbortSignal.timeout(10_000) },
      async (res) => {
        try {
          let body = "";
          res.setEncoding("utf8");
          for await (const chunk of res) body += chunk;
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"],
            body,
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    request.on("error", reject);
  });
}

function apiReader(worker, ca, token) {
  return async (route, authenticated = true) => {
    const { status, body } = await response(
      new URL("/api/v1" + route, worker),
      ca,
      authenticated ? { authorization: "Bearer " + token } : {},
    );
    assert.equal(status, 200, route + " " + body);
    const json = JSON.parse(body);
    assert.equal(json.success, true);
    return json.data;
  };
}

function commandRunner(cli) {
  return async (name, now, args, verify, expectedCode = 0) =>
    step(name, async (entry) => {
      entry.command = args;
      entry.clock = now;
      const options = {
        cwd: root,
        env: { ...cli.env, LITSCOUT_REHEARSAL_NOW: now },
        timeout: 120_000,
        maxBuffer: 2_000_000,
      };
      const output = await exec(
        process.execPath,
        [cliEntry, ...args, "--json", "--config", cli.config],
        options,
      )
        .then((value) => ({ ...value, code: 0 }))
        .catch((error) => ({
          code: error.code ?? error.signal,
          stdout: error.stdout,
          stderr: error.stderr,
        }));
      entry.exitCode = output.code;
      entry.stderr = output.stderr;
      try {
        entry.result = JSON.parse(output.stdout);
      } catch {
        entry.stdout = output.stdout;
      }
      assert.equal(output.code, expectedCode, "Unexpected CLI exit code");
      assert.doesNotMatch(output.stderr, /Unexpected rehearsal request/);
      assert.equal(
        entry.result?.success,
        true,
        "Expected successful JSON envelope",
      );
      await verify(entry.result.data, entry);
      return entry.result.data;
    });
}

const match = (actual, expected) =>
  assert.partialDeepStrictEqual(actual, expected);
const mondayMorning = monday + "T02:20:00Z";
const tuesdayEvening = tuesday + "T09:59:00Z";
const wednesdayMorning = wednesday + "T02:20:00Z";
const thursdayBeforeCutoff = thursday + "T09:59:00Z";
const thursdayCutoff = thursday + "T10:00:00Z";
const oneFallback = [
  { from: "codex", to: "claude", reason: "quota exhausted" },
];

const skipped = { status: "skipped" };
const done = { status: "done" };
const pending = { status: "pending" };
const paused = { status: "paused", error: "budget" };
const codex = { status: "done", client: "codex" };
const claudeFallback = { status: "done", client: "claude", fallback: true };

async function verifyHealth(api, runs) {
  await step("Health shows scheduled runs", async (entry) => {
    const { runs: actual } = await api("/operations/health");
    entry.result = actual;
    assert.equal(actual.length, runs.length);
    for (const expected of runs) {
      const run = actual.find((row) => row.id === expected.id);
      assert.deepEqual(run, expected);
    }
  });
}

async function verifyBackup(command, directory) {
  const file = path.join(directory, "rehearsal.json.gz");
  const exported = await command(
    "backup export",
    thursdayCutoff,
    ["backup", "--out", file],
    (data) =>
      match(data, {
        file,
        schemaVersion: 1,
        counts: {
          digests: 3,
          papers: 2,
          paperIdentifiers: 2,
          paperLinks: 4,
          configuredTopics: 2,
          vaultIndex: 0,
        },
      }),
  );
  await command(
    "backup verify",
    thursdayCutoff,
    ["backup", "--verify", file],
    (data) => {
      assert.deepEqual(data, {
        verified: true,
        file,
        schemaVersion: 1,
        instanceName: "LitScout",
        createdAt: new Date(thursdayCutoff).toISOString(),
        counts: exported.counts,
        expectedCounts: exported.counts,
        warnings: [],
      });
    },
  );
  return { file, counts: exported.counts };
}

// Restore the export into a second, empty local Worker and export it again.
async function verifyRestore(cli, tls, directory, exported) {
  const target = await webRuntime({
    empty: {
      scriptPath: path.join(root, "apps/worker/dist/bundle/worker.js"),
    },
    assets: path.join(root, "apps/web/dist"),
    localDev: true,
    publicLimitOff: true,
    backupCooldownOff: true,
    tls,
  });
  try {
    const worker = (await target.ready).origin;
    const token = await createToken(await target.getD1Database("DB"));
    const credentials = path.join(cli.state, "credentials.json");
    const saved = JSON.parse(await readFile(credentials, "utf8"));
    await writeFile(
      credentials,
      JSON.stringify({
        ...saved,
        tokens: [...saved.tokens, { token, url: worker }],
      }),
      { mode: 0o600 },
    );
    const config = path.join(directory, "restore.config.ts");
    await writeFile(
      config,
      (await readFile(cli.config, "utf8")).replaceAll(
        cli.env.LITSCOUT_REHEARSAL_WORKER,
        worker,
      ),
    );
    const command = commandRunner({
      ...cli,
      config,
      env: { ...cli.env, LITSCOUT_REHEARSAL_WORKER: worker },
    });
    const rows = Object.entries(exported.counts)
      .filter(([section]) => section !== "configuredTopics")
      .reduce((sum, [, count]) => sum + count, 0);
    await command(
      "backup restore plan",
      thursdayCutoff,
      ["backup", "restore", exported.file, "--dry-run"],
      (data) => match(data, { dryRun: true, resumeAt: 0, fitsToday: true }),
    );
    await command(
      "backup restore",
      thursdayCutoff,
      ["backup", "restore", exported.file],
      (data) => match(data, { status: "done", inserted: rows, skipped: 0 }),
    );
    const again = path.join(directory, "restored.json.gz");
    await command(
      "backup export after restore",
      thursdayCutoff,
      ["backup", "--out", again],
      (data) => assert.deepEqual(data.counts, exported.counts),
    );
    await step("restored export matches the original", async (entry) => {
      const sha256 = async (file) =>
        JSON.parse(gunzipSync(await readFile(file)).toString("utf8")).sha256;
      entry.result = await sha256(again);
      assert.equal(entry.result, await sha256(exported.file));
    });
  } finally {
    await target.dispose();
  }
}

const reportedCommands = {
  "daily fetch": "fetch",
  "summaries run": "summaries",
  "digest run": "digest",
  "digest final": "digest",
  "sync --dry-run": "sync",
  "legacy import": "legacy",
};

async function scheduledRun(command, directory, name, now, run, expected) {
  const startedAt = new Date(now).toISOString();
  const start = await command(
    name + " daily start",
    now,
    ["daily", "start"],
    (data) => {
      assert.match(data.id, /^[a-f\d-]{36}$/i);
      match(data, { startedAt, targetDay: startedAt.slice(0, 10) });
    },
  );
  let targetDay = start.targetDay;
  let finishedAt = now;
  let rowsWritten = 0;
  const steps = {
    fetch: skipped,
    summaries: skipped,
    digest: skipped,
    sync: skipped,
    legacy: skipped,
  };
  await run(async (label, clock, args, verify, expectedCode) => {
    const data = await command(label, clock, args, verify, expectedCode);
    finishedAt = clock;
    const key = reportedCommands[args.slice(0, 2).join(" ")];
    if (!key) return data;
    const client = data.clientsUsed?.at(-1);
    const status =
      data.status === "budget-short"
        ? paused
        : ["pending", "no-new-batch"].includes(data.status)
          ? pending
          : done;
    steps[key] = {
      ...status,
      ...(client ? { client } : {}),
      ...(data.fallback?.length ? { fallback: true } : {}),
    };
    if ((key === "summaries" || key === "digest") && data.day)
      targetDay = data.day;
    const rows = data.ingest?.rowsWritten ?? data.rowsWritten;
    rowsWritten =
      rowsWritten === null || !Number.isInteger(rows)
        ? null
        : rowsWritten + rows;
    return data;
  });
  const input = { id: start.id, startedAt, targetDay, steps, rowsWritten };
  const file = path.join(directory, "health-" + start.id + ".json");
  await writeFile(file, JSON.stringify(input), { mode: 0o600 });
  const saved = await command(
    name + " daily report",
    finishedAt,
    ["daily", "report", file],
    (data) => {
      match(data, {
        id: input.id,
        targetDay,
        finishedAt: new Date(finishedAt).toISOString(),
      });
      match(input, expected);
    },
  );
  return { ...input, finishedAt: saved.finishedAt };
}

async function initialChecks(command) {
  await command(
    "doctor",
    mondayMorning,
    ["doctor"],
    ({ checks, configValid }) => {
      assert.equal(configValid, true);
      for (const [name, check] of Object.entries(checks))
        assert.equal(check.ok, true, name);
      match(checks, {
        schema: { actual: checks.schema.expected },
        token: { present: true, read: true, ingest: true },
        vaultRoot: { configured: true },
        vaultWrite: { enabled: false },
      });
    },
  );
  await command("initial budget", mondayMorning, ["budget"], (data) => {
    match(data, { limit: 80_000, reserved: 0 });
    // The authenticated health check may charge a token last-used update.
    assert.ok(data.used >= 0 && data.used <= 10);
    assert.ok(data.resetAt.endsWith("T00:00:00.000Z"));
  });
  await command(
    "empty daily status",
    mondayMorning,
    ["daily", "status"],
    (data) => assert.deepEqual(data, []),
  );
}

async function mondayRun(command) {
  await command("Monday fetch", mondayMorning, ["daily", "fetch"], (data) => {
    match(data, {
      status: "crawled",
      day: monday,
      added: 1,
      arxivAdded: 1,
      venuesAdded: 0,
      skipped: 0,
    });
    assert.deepEqual(data.gaps, []);
    assert.ok(
      data.warnings.some((warning) => warning.includes("recorded as seen")),
    );
  });
  await command(
    "Monday summaries",
    mondayMorning,
    ["summaries", "run"],
    (data) => {
      match(data, { day: monday, status: "done", ran: 1, stopped: null });
      assert.deepEqual(data.clientsUsed, ["codex"]);
      assert.deepEqual(data.failures, []);
    },
  );
  await command(
    "Monday digest context",
    mondayMorning,
    ["digest", "context"],
    (data) => {
      assert.equal(data.day, monday);
      assert.deepEqual(
        data.all.map(({ title, tldr }) => [title, tldr]),
        [[mondayPaper.title, mondayPaper.title]],
      );
    },
  );
  await command("Monday digest", mondayMorning, ["digest", "run"], (data) => {
    match(data, { day: monday, status: "written", counts: { total: 1 } });
    // A written digest refreshes its month's trends itself.
    match(data.trends, { status: "refreshed", rowsWritten: 1 });
    assert.deepEqual(data.clientsUsed, ["codex"]);
    assert.match(data.bodyMd, new RegExp("/public/days/" + monday));
  });
}

async function pendingRun(command) {
  await command(
    "Tuesday still pending",
    tuesdayEvening,
    ["daily", "fetch"],
    (data) => {
      match(data, { day: tuesday, status: "pending", added: 0 });
      assert.ok(data.message.includes("latest available listing is " + monday));
    },
  );
}

async function budgetShortRun(command, api, db) {
  const { day, used, limit, resetAt } = await api("/budget");
  const setUsage = (rows) =>
    db
      .prepare("UPDATE daily_write_usage SET rows_written=? WHERE day=?")
      .bind(rows, day)
      .run();
  await setUsage(limit - 1);
  try {
    await command(
      "late fetch with tiny budget",
      wednesdayMorning,
      ["daily", "fetch"],
      async (data) => {
        match(data, {
          day: wednesday,
          status: "budget-short",
          availableRows: 1,
          added: 0,
          resumeAt: resetAt,
        });
        assert.ok(data.requiredRows > 1);
        assert.equal(data.shortfall, data.requiredRows - data.availableRows);
        match(await api("/feed/days/" + tuesday), {
          status: "pending",
          counts: { total: 0 },
        });
      },
      2,
    );
  } finally {
    await setUsage(used);
  }
}

async function lateRun(command, fixtures, cli) {
  const requests = fixtures.requests.length;
  await command(
    "resume late fetch",
    wednesdayMorning,
    ["daily", "fetch"],
    (data) => {
      match(data, {
        day: wednesday,
        status: "pending",
        added: 2,
        arxivAdded: 1,
        venuesAdded: 1,
        skipped: 0,
      });
      assert.deepEqual(data.venueOnlyDays, []);
      assert.ok(
        data.message.includes("latest available listing is " + tuesday),
      );
      assert.equal(
        fixtures.requests.length,
        requests,
        "Resume fetched sources again",
      );
    },
  );
  await command(
    "late listing status",
    wednesdayMorning,
    ["daily", "status"],
    (rows) => {
      match(
        rows.find((row) => row.day === tuesday),
        { target: true, status: "crawled", crawled: true },
      );
      match(
        rows.find((row) => row.day === wednesday),
        { status: "pending", crawled: false },
      );
      assert.deepEqual(
        rows.filter((row) => row.target).map((row) => row.day),
        [tuesday],
      );
    },
  );

  await writeFile(path.join(cli.home, "fail-codex"), "");
  await command(
    "Tuesday summaries with fallback",
    wednesdayMorning,
    ["summaries", "run"],
    (data) => {
      match(data, { day: tuesday, status: "done", stopped: null });
      assert.deepEqual(data.clientsUsed, ["codex", "claude"]);
      assert.deepEqual(data.fallback, oneFallback);
      assert.deepEqual(data.failures, []);
    },
  );
  await command(
    "Tuesday digest with fallback",
    wednesdayMorning,
    ["digest", "run"],
    (data) => {
      match(data, { day: tuesday, status: "written", counts: { total: 1 } });
      assert.deepEqual(data.clientsUsed, ["codex", "claude"]);
      assert.deepEqual(data.fallback, oneFallback);
      assert.match(data.bodyMd, new RegExp("/public/days/" + tuesday));
    },
  );
}

async function finalRun(command) {
  // Use the next day: a late listing already digested today suppresses a
  // second report even after the cutoff.
  await command(
    "Thursday still pending",
    thursdayBeforeCutoff,
    ["daily", "fetch"],
    (data) => match(data, { day: thursday, status: "pending", added: 0 }),
  );
  await command(
    "final before 18:00",
    thursdayBeforeCutoff,
    ["digest", "final"],
    (data) => match(data, { day: thursday, status: "no-new-batch" }),
    2,
  );
  await command(
    "final at 18:00",
    thursdayCutoff,
    ["digest", "final"],
    (data) => {
      match(data, { day: thursday, status: "written-no-batch" });
      assert.ok(data.bodyMd.includes(thursday));
      assert.match(data.bodyMd, /arXiv has no new batch today/);
    },
  );
}

async function maintenance(command, api, cli, directory) {
  const month = tuesday.slice(0, 7);
  await command(
    "refresh monthly trends after the digest",
    thursdayCutoff,
    ["trends", "refresh", "--month", month],
    (data) =>
      // The digests already refreshed this month, so nothing changes.
      match(data, { status: "refreshed", month, topics: 1, rowsWritten: 0 }),
  );
  await command(
    "read the stored monthly trends",
    thursdayCutoff,
    ["trends", "--topic", "Vision", "--month", month],
    (data) => {
      match(data, { month, topic: "Vision" });
      assert.ok(data.detail.volume > 0);
      assert.ok(data.detail.pickCount > 0);
    },
  );
  const budget = await api("/budget");
  await command(
    "vault sync preview",
    thursdayCutoff,
    ["sync", "--dry-run"],
    async (data) => {
      match(data, {
        dryRun: true,
        writeEnabled: false,
        index: "planned",
        counts: { idea: 1 },
      });
      assert.deepEqual(data.issues, []);
      // Today's digest, then the earlier days of the week that have a digest
      // and no file yet (sync catches up six days back).
      assert.deepEqual(
        data.writes,
        [thursday, tuesday, monday].map((day) => ({
          kind: "digest",
          mode: "planned",
          path: "LitScout/Digests/" + day + ".md",
        })),
      );
      assert.match(data.summary, /^Dry-run · index planned/);
      assert.deepEqual(await readdir(cli.vault), ["Idea.md"]);
      assert.equal(
        await readFile(path.join(cli.vault, "Idea.md"), "utf8"),
        ideaText,
      );
      assert.deepEqual(
        await api("/budget"),
        budget,
        "Dry-run consumed write budget",
      );
    },
  );
  await command(
    "day reopen preview",
    thursdayCutoff,
    ["day", "reopen", thursday, "--dry-run"],
    (data) => {
      match(data, {
        day: thursday,
        dryRun: true,
        changed: true,
        oldStatus: "final",
        newStatus: "pending",
      });
      assert.deepEqual(
        data.digests.map(({ lang }) => lang),
        ["en"],
      );
    },
  );
  const { repo, git } = await legacyRepository(directory, cli.env);
  const head = (await git("rev-parse", "HEAD")).stdout;
  await command(
    "legacy import",
    thursdayCutoff,
    [
      "legacy",
      "import",
      "--repo",
      repo,
      "--from",
      legacyDay,
      "--to",
      legacyDay,
      "--max-rows",
      "1000",
    ],
    async (data) => {
      assert.equal(data.status, "done");
      assert.deepEqual(data.counts, [
        { day: legacyDay, papers: 1, summaries: 0, skipped: 0 },
      ]);
      const feed = await api("/feed/days/" + legacyDay);
      assert.deepEqual(
        feed.items.map(({ title }) => title),
        [legacyTitle],
      );
      assert.equal((await git("rev-parse", "HEAD")).stdout, head);
      assert.equal((await git("status", "--porcelain")).stdout, "");
    },
  );
}

async function verifyHttp(api, worker, ca) {
  await step("public day pages and private API", async (entry) => {
    for (const day of [tuesday, thursday]) {
      const html = await response(new URL("/public/days/" + day, worker), ca);
      assert.equal(html.status, 200);
      assert.match(html.type, /^text\/html/);
      assert.match(html.body, /<div id="root"><\/div>/);
      const asset = html.body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      assert.ok(asset, "Expected built web JavaScript");
      assert.equal((await response(new URL(asset, worker), ca)).status, 200);
    }
    const mondayFeed = await api("/public/days/" + monday, false);
    const reading = await api("/public/days/" + tuesday, false);
    const pending = await api("/public/days/" + wednesday, false);
    const final = await api("/public/days/" + thursday, false);
    const privateReading = await api(
      "/feed/days/" + tuesday + "/digest?lang=en",
    );
    const privateFinal = await api(
      "/feed/days/" + thursday + "/digest?lang=en",
    );
    entry.result = {
      monday: mondayFeed,
      reading,
      pending,
      final,
      privateReading,
      privateFinal,
    };
    assert.deepEqual(
      mondayFeed.items.map(({ title, hfUpvotes }) => [title, hfUpvotes]),
      [[mondayPaper.title, 7]],
    );
    match(reading, {
      day: tuesday,
      status: "digested",
      counts: { total: 2, arxiv: 1, venues: 1, summarised: 2 },
    });
    assert.deepEqual(
      reading.items.map(({ title }) => title).sort(),
      [tuesdayPaper.title, venueTitle].sort(),
    );
    const arxiv = reading.items.find(({ source }) => source === "arxiv");
    match(arxiv, {
      hfUpvotes: 13,
      shortlisted: true,
      tldr: [{ lang: "en", text: tuesdayPaper.title }],
    });
    match(pending, { day: wednesday, status: "pending", counts: { total: 0 } });
    match(final, { day: thursday, status: "final", counts: { total: 0 } });
    assert.deepEqual(final.items, []);
    // Each pick names its paper, so the reader needs no second lookup.
    assert.deepEqual(privateReading.picks, [
      {
        paperId: arxiv.paperId,
        source: "arxiv",
        day: tuesday,
        title: tuesdayPaper.title,
        topics: arxiv.topics,
      },
    ]);
    assert.match(
      privateReading.bodyMd,
      new RegExp("Fixture digest for " + tuesday),
    );
    match(privateFinal, { day: thursday, final: true });
    assert.ok(privateFinal.bodyMd.includes(thursday));
    assert.match(privateFinal.bodyMd, /arXiv has no new batch today/);
    const denied = await response(
      new URL("/api/v1/feed/days/" + thursday + "/digest?lang=en", worker),
      ca,
      { authorization: "Bearer invalid" },
    );
    assert.equal(denied.status, 401);
  });
}

async function rehearsal() {
  await step("build", async (entry) => {
    try {
      const { stdout, stderr } = await exec("pnpm", ["build"], {
        cwd: root,
        timeout: 120_000,
      });
      Object.assign(entry, { stdout, stderr });
    } catch (error) {
      Object.assign(entry, { stdout: error.stdout, stderr: error.stderr });
      throw new Error("pnpm build did not finish successfully");
    }
  });
  const directory = await mkdtemp(
    path.join(await realpath(tmpdir()), "litscout-rehearsal-"),
  );
  let runtime, fixtures;
  try {
    const { db, token, worker, ca, cli, tls } = await step(
      "local Worker and fixtures",
      async () => {
        const tls = await certificate(directory);
        fixtures = await startFixtures();
        runtime = await webRuntime({
          empty: {
            scriptPath: path.join(root, "apps/worker/dist/bundle/worker.js"),
          },
          assets: path.join(root, "apps/web/dist"),
          localDev: true,
          publicLimitOff: true,
          backupCooldownOff: true,
          tls,
        });
        const worker = (await runtime.ready).origin;
        const db = await runtime.getD1Database("DB");
        const token = await createToken(db);
        return {
          db,
          token,
          worker,
          tls,
          ca: tls.cert,
          cli: await setupCli(
            directory,
            worker,
            fixtures.origin,
            tls.ca,
            token,
          ),
        };
      },
    );
    const command = commandRunner(cli);
    const api = apiReader(worker, ca, token);
    const run = (name, clock, work, expected) =>
      scheduledRun(command, directory, name, clock, work, expected);
    await initialChecks(command);
    const runs = [];
    runs.push(
      await run("Monday", mondayMorning, mondayRun, {
        targetDay: monday,
        steps: {
          fetch: done,
          summaries: codex,
          digest: codex,
          sync: skipped,
          legacy: skipped,
        },
      }),
    );
    runs.push(
      await run("Tuesday", tuesdayEvening, pendingRun, {
        targetDay: tuesday,
        steps: {
          fetch: pending,
          summaries: skipped,
          digest: skipped,
          sync: skipped,
          legacy: skipped,
        },
      }),
    );
    fixtures.releaseLateBatch();
    runs.push(
      await run(
        "Wednesday budget pause",
        wednesdayMorning,
        (track) => budgetShortRun(track, api, db),
        {
          targetDay: wednesday,
          steps: {
            fetch: paused,
            summaries: skipped,
            digest: skipped,
            sync: skipped,
            legacy: skipped,
          },
        },
      ),
    );
    runs.push(
      await run(
        "Wednesday resume",
        wednesdayMorning,
        (track) => lateRun(track, fixtures, cli),
        {
          targetDay: tuesday,
          steps: {
            fetch: pending,
            summaries: claudeFallback,
            digest: claudeFallback,
            sync: skipped,
            legacy: skipped,
          },
        },
      ),
    );
    runs.push(
      await run(
        "Thursday",
        thursdayBeforeCutoff,
        async (track) => {
          await finalRun(track);
          await maintenance(track, api, cli, directory);
        },
        {
          targetDay: thursday,
          steps: {
            fetch: pending,
            summaries: skipped,
            digest: done,
            sync: done,
            legacy: done,
          },
        },
      ),
    );
    await verifyHealth(api, runs);
    const exported = await verifyBackup(command, directory);
    await verifyRestore(cli, tls, directory, exported);
    await verifyHttp(api, worker, ca);
  } finally {
    report.sourceRequests = fixtures?.requests;
    const results = await Promise.allSettled([
      runtime?.dispose(),
      fixtures?.close(),
    ]);
    await rm(directory, { recursive: true, force: true });
    const failure = results.find(({ status }) => status === "rejected");
    if (failure) throw failure.reason;
  }
}

await mkdir(path.dirname(transcript), { recursive: true });
await saveReport();
try {
  await rehearsal();
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
} finally {
  await saveReport();
  process.stdout.write(`Transcript: ${transcript}\n`);
}
