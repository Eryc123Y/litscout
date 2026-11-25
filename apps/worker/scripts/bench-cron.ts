import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseListing } from "@litscout/sources/listings";
import { listingInput } from "@litscout/pipeline/arxiv-listing-input";
import {
  cappedCvListing,
  recordedListing as recordedNew,
  scheduledFixtureUrl,
} from "../test/helpers/cron-listing";
import { securityWorker } from "../test/helpers/security-worker";

const warmup = 20;
const samples = 100;
const fixtureDir = "packages/sources/test/fixtures/listings";
const templates = recordedNew.match(/<dt>[\s\S]*?<\/dd>/g)!.slice(0, 72);

function syntheticPage(
  category: string,
  [fresh, cross, replacements]: [number, number, number],
  shownFresh = fresh,
) {
  const section = (
    label: string,
    offset: number,
    shown: number,
    total: number,
  ) =>
    total
      ? `<h3>${label} (showing ${shown} of ${total} entries)</h3>` +
        Array.from({ length: shown }, (_, i) => {
          const index = offset + i;
          return templates[index % templates.length]!.replace(
            /item\d+/,
            `item${index + 1}`,
          )
            .replace(
              /2611\.\d{5}/g,
              `2611.${String(30000 + index).padStart(5, "0")}`,
            )
            .replaceAll("cs.CV", category);
        }).join("")
      : "";
  return `<!DOCTYPE html><div id="dlpage"><h3>Showing new listings for Monday, 16 November 2026</h3>
    <ul><li><a href="#item0">New submissions</a></li>
    ${cross ? `<li><a href="#item${fresh + 1}">Cross-lists</a></li>` : ""}
    ${replacements ? `<li><a href="#item${fresh + cross + 1}">Replacements</a></li>` : ""}
    </ul><div>Total of ${fresh + cross + replacements} entries</div><dl>
    ${section("New submissions", 0, shownFresh, fresh)}
    ${section("Cross submissions", fresh, cross, cross)}
    ${section("Replacement submissions", fresh + cross, replacements, replacements)}
    </dl></div>`;
}

type Measurement = { cpu: number; wall: number };

function percentiles(values: number[]) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    median: Number(((values[middle - 1]! + values[middle]!) / 2).toFixed(3)),
    p95: Number(values[Math.ceil(values.length * 0.95) - 1]!.toFixed(3)),
  };
}

async function measure<T>(
  cpu: () => number,
  call: (index: number) => Promise<Pick<Response, "ok" | "json">>,
  validate: (value: T) => void,
  prepare?: (index: number) => Promise<unknown>,
) {
  const timings: Measurement[] = [];
  const results: T[] = [];
  for (let index = 0; index < warmup + samples; index++) {
    await prepare?.(index);
    const startCpu = cpu();
    const startWall = performance.now();
    const response = await call(index);
    const result = await response.json<T>();
    const wall = performance.now() - startWall;
    const consumedCpu = (cpu() - startCpu) / 1e6;
    if (!response.ok) throw new Error(JSON.stringify(result));
    validate(result);
    if (index >= warmup) {
      timings.push({ cpu: consumedCpu, wall });
      results.push(result);
    }
  }
  return {
    cpuMs: percentiles(timings.map((row) => row.cpu)),
    wallMs: percentiles(timings.map((row) => row.wall)),
    results,
  };
}

type ParseResult = { papers: number; complete: boolean; total: number };
type IngestResult = {
  data: { accepted: number };
  meta: {
    rowsWritten: number;
    budgetRowsWritten: number;
    authRowsWritten: number;
  };
  d1Calls: number;
};
const bytes = (value: string) => Buffer.byteLength(value);
const busy = syntheticPage("cs.LG", [300, 450, 1250]);
const cases = [
  ["cs.CV fixture", "cs.CV", "new", recordedNew],
  [
    "cs.CV recent fixture",
    "cs.CV",
    "recent",
    readFileSync(join(fixtureDir, "fresh_recent_cs_CV.html"), "utf8"),
  ],
  ["cs.AI", "cs.AI", "new", syntheticPage("cs.AI", [300, 400, 1000])],
  ["cs.LG busy", "cs.LG", "new", busy],
  ["cs.CL", "cs.CL", "new", syntheticPage("cs.CL", [140, 180, 480])],
  ["stat.ML", "stat.ML", "new", syntheticPage("stat.ML", [100, 120, 280])],
  ["cs.GR", "cs.GR", "new", syntheticPage("cs.GR", [40, 40, 70])],
  ...[10, 25, 50, 100].map(
    (count) =>
      [
        `cs.LG capped at ${count}`,
        "cs.LG",
        "new",
        syntheticPage("cs.LG", [300, 0, 0], count),
      ] as const,
  ),
] as const;

const scratch = mkdtempSync(join(tmpdir(), "litscout-m4d-"));
try {
  const clock = join(scratch, "workerd-cpu");
  execFileSync("cc", [
    "-O2",
    fileURLToPath(new URL("./workerd-cpu.c", import.meta.url)),
    "-o",
    clock,
  ]);
  const processCpu = (pid: string) =>
    Number(execFileSync(clock, [pid], { encoding: "utf8" }));
  // Verify clock units against Node's getrusage-based clock before using it
  // on workerd. In particular, macOS on ARM reports Mach ticks.
  const sampleSelf = () => processCpu(String(process.pid));
  const before = sampleSelf();
  const nodeBefore = process.cpuUsage();
  let nodeDelta: number;
  do {
    const usage = process.cpuUsage(nodeBefore);
    nodeDelta = (usage.user + usage.system) * 1000;
  } while (nodeDelta < 30_000_000);
  const clockRatio = (sampleSelf() - before) / nodeDelta;
  if (clockRatio < 0.9 || clockRatio > 1.15)
    throw new Error(
      `Process CPU clock disagrees with Node by a factor of ${clockRatio}`,
    );

  const stageHtml = cappedCvListing();
  const local = await securityWorker({
    entryPoint: "apps/worker/scripts/cron-benchmark-worker.ts",
    bindings: { CRON_CRAWL_TRIAL: "true" },
    kvNamespaces: ["CRON_CRAWL_STAGE"],
    scheduled: true,
    outboundService: (request) =>
      request.url === "https://arxiv.org/list/cs.CV/new?skip=0&show=10"
        ? new Response(stageHtml)
        : new Response("Network disabled", { status: 503 }),
  });
  try {
    const pid = execFileSync(
      "pgrep",
      ["-P", String(process.pid), "-x", "workerd"],
      { encoding: "utf8" },
    ).trim();
    if (!/^\d+$/.test(pid))
      throw new Error("Expected exactly one child workerd process");
    const cpu = () => processCpu(pid);
    const send = (path: string, body: string) =>
      local.endpoint.fetch("http://local" + path, { method: "POST", body });
    const show = (value: object) =>
      process.stdout.write(JSON.stringify(value) + "\n");
    show({
      warmup,
      samples,
      cpuClock: "isolated workerd process user + system",
      clockRatio: Number(clockRatio.toFixed(3)),
      wallClock: "Node performance.now",
    });
    const stage = await measure<{ outcome: string }>(
      cpu,
      () => local.worker.dispatchFetch(scheduledFixtureUrl),
      ({ outcome }) => {
        if (outcome !== "ok") throw new Error(`Scheduled outcome: ${outcome}`);
      },
    );
    const staged = await (
      await local.worker.getKVNamespace("CRON_CRAWL_STAGE")
    ).get("arxiv/2026-11-16/cs.CV/0");
    if (!staged)
      throw new Error("The scheduled handler did not stage a listing");
    show({
      step: "scheduled parse and stage",
      inputBytes: bytes(stageHtml),
      stageBytes: bytes(staged),
      cpuMs: stage.cpuMs,
      wallMs: stage.wallMs,
    });
    const noop = await measure(
      cpu,
      () => send("/noop", busy),
      () => {},
    );
    show({
      step: "read body only",
      bytes: bytes(busy),
      cpuMs: noop.cpuMs,
      wallMs: noop.wallMs,
    });
    for (const [name, category, kind, html] of cases) {
      const expected = await parseListing(html, category, kind);
      if (
        !expected.papers.length ||
        expected.complete === name.includes("capped")
      )
        throw new Error(`Unexpected fixture shape: ${name}`);
      const result = await measure<ParseResult>(
        cpu,
        () => send(`/parse?category=${category}&kind=${kind}`, html),
        (row) => {
          if (
            row.papers !== expected.papers.length ||
            row.complete !== expected.complete ||
            row.total !== expected.total
          )
            throw new Error(`Parse mismatch: ${name}`);
        },
      );
      show({
        step: "parse",
        name,
        bytes: bytes(html),
        ...result.results[0],
        cpuMs: result.cpuMs,
        wallMs: result.wallMs,
      });
    }
    const source = (await parseListing(recordedNew, "cs.CV", "new")).papers;
    const paperAt = (index: number, id: string) => ({
      ...source[index % source.length]!,
      id,
      abs: `https://arxiv.org/abs/${id}`,
      pdf: `https://arxiv.org/pdf/${id}`,
    });
    for (const count of [20, 328, 1335]) {
      const papers = Array.from({ length: count }, (_, i) =>
        paperAt(i, `2611.${30000 + i}`),
      );
      const body = JSON.stringify(papers);
      const result = await measure<{ papers: number; batches: number }>(
        cpu,
        () => send("/plan", body),
        (row) => {
          if (row.papers !== count || row.batches !== Math.ceil(count / 20))
            throw new Error("Unexpected batch plan");
        },
      );
      show({
        step: "normalize and plan",
        bytes: bytes(body),
        ...result.results[0],
        cpuMs: result.cpuMs,
        wallMs: result.wallMs,
      });
    }
    for (const [scenario, count] of [1, 5, 10, 20, 40].entries()) {
      const payloads = Array.from({ length: warmup + samples }, (_, index) => ({
        day: "2026-11-17",
        papers: Array.from({ length: count }, (_, i) => {
          const id = `2611.${40000 + scenario * 10000 + index * count + i}`;
          return listingInput(paperAt(index + i, id));
        }),
      }));
      const result = await measure<IngestResult>(
        cpu,
        (index) => local.call("/ingest/papers", "POST", payloads[index]),
        (row) => {
          if (row.data.accepted !== count || row.meta.rowsWritten < count)
            throw new Error("Expected new rows from the existing write path");
        },
        async (index) => {
          if (index % 30 === 0)
            await local.db.batch([
              local.db.prepare("DELETE FROM write_leases"),
              local.db.prepare("DELETE FROM daily_write_usage"),
            ]);
        },
      );
      const range = (values: number[]) => [
        Math.min(...values),
        Math.max(...values),
      ];
      show({
        step: "HTTP ingest",
        papers: count,
        cpuMs: result.cpuMs,
        wallMs: result.wallMs,
        d1Calls: range(result.results.map((row) => row.d1Calls)),
        paperRows: range(result.results.map((row) => row.meta.rowsWritten)),
        budgetRows: range(
          result.results.map(
            (row) => row.meta.budgetRowsWritten + row.meta.authRowsWritten,
          ),
        ),
      });
    }
  } finally {
    await local.worker.dispose();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
