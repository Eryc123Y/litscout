import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { DailyRunView } from "@litscout/pipeline/health-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateConfig } from "@litscout/core";
import { SCHEMA_VERSION } from "@litscout/db";
import { putBlock } from "@litscout/sync/vault-note";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";
import { doctorResponse } from "./helpers/doctor";

let dir: string;
const day = "2026-11-18";
const now = new Date(day + "T04:30:00.000Z");
const days = ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", day];
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-cutover-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function fixture({ analytics = false } = {}) {
  const vault = path.join(dir, "vault");
  const work = path.join(dir, "fake-home", ".cache/litscout/run");
  const reports = path.join(work, "shadow-reports");
  const state = path.join(dir, "state");
  const configFile = path.join(dir, "litscout.config.ts");
  const backup = path.join(dir, "litscout-backup-fixture.json.gz");
  for (const folder of [vault, reports, state])
    await mkdir(folder, { recursive: true });
  const settings = {
    instance: {
      publicUrl: "https://fixture.invalid",
      timezone: "Asia/Kuala_Lumpur",
    },
    vault: { root: "./vault", digestsDir: "Digests-new" },
  };
  const configText = "export default " + JSON.stringify(settings);
  await writeFile(configFile, configText);
  const config = validateConfig(settings);
  const out: string[] = [];
  const reply = (data: unknown) =>
    Response.json({ success: true, data, meta: { rowsWritten: 1 } });
  const paper = {
    id: "pap_fixture",
    title: "Fixture paper",
    arxiv: "2406.09414",
    notes: [],
    links: [],
    topics: [],
  };
  const requests = [
    { id: "req_fixture", kind: "capture", title: "Later", paper },
  ];
  let hasDigest = true;
  let version = SCHEMA_VERSION;
  let failIndex = false;
  let runEvidence: unknown = { hasRuns: false, runs: [] };
  const fetcher = vi.fn(async (input: URL, init?: RequestInit) => {
    if (input.pathname === "/health") return doctorResponse(input);
    if (input.pathname === "/api/v1/vault/health") {
      return reply({
        database: { reachable: true, schemaVersion: version },
        token: { scopes: ["read", "ingest", "vault"], legacyVault: false },
        bindings: { DB: true, OAUTH_KV: true },
      });
    }
    const method = init?.method ?? "GET";
    const route = input.pathname.replace(/^\/api\/v1/, "");
    switch (route) {
      case "/operations/health":
        expect(input.searchParams.get("cutoverDays")).toBe(
          [...days].reverse().join(","),
        );
        return runEvidence instanceof Response
          ? runEvidence.clone()
          : reply(runEvidence);
      case "/vault/budget":
        return doctorResponse(new URL("/api/v1/budget", input));
      case "/budget":
        return doctorResponse(input);
      case "/vault/requests":
        expect(method).toBe("GET");
        return reply(requests);
      case "/vault/index":
        if (failIndex && method === "PUT")
          return new Response(null, { status: 400 });
        return reply(
          method === "GET"
            ? { snapshot: null, count: 0 }
            : { published: true, accepted: true },
        );
      case "/vault/digests/" + day:
        return reply(hasDigest ? { day, markdown: "Fixture digest" } : null);
      case "/vault/matches":
        return reply([
          {
            id: JSON.parse(input.searchParams.get("note")!).id,
            paperId: paper.id,
          },
        ]);
      case "/vault/papers":
        return reply([paper]);
      case "/vault/report":
        return reply({ recorded: true });
      default:
        // Sync also asks for the six days before; none has a digest here.
        if (route.startsWith("/vault/digests/")) return reply(null);
        throw new Error("Unexpected fixture route " + route);
    }
  });
  const run = vi.fn(async ([command, action]: string[]) =>
    command === "--version"
      ? "4.151.0"
      : command === "whoami"
        ? "Signed in"
        : command === "d1" && action === "info"
          ? JSON.stringify({ uuid: "0522bdb2-8b4a-45d5-bae9-ef29cbfbdf03" })
          : "{}",
  );
  const deps = {
    cwd: dir,
    dir: state,
    env: {
      HOME: path.join(dir, "fake-home"),
      ...(analytics && {
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        CLOUDFLARE_API_TOKEN: "synthetic",
      }),
    },
    loadConfig: async () => config,
    flow: {
      token: "fixture",
      now: () => now,
      preflight: async (client: string) => ({
        client,
        usable: true,
        reason: "ready",
      }),
    },
    fetch: fetcher,
    run,
    print: (line: string) => out.push(line),
  } as unknown as SetupDeps;
  const call = async (...args: string[]) => {
    const code = await runCommand([...args, "--json"], deps);
    return { code, ...JSON.parse(out.at(-1)!) };
  };
  const text = async (...args: string[]) => {
    await runCommand(args, deps);
    return out.at(-1)!;
  };
  const saveRun = (runDay: string, override = {}) =>
    writeFile(
      path.join(reports, runDay + ".json"),
      JSON.stringify({
        version: 1,
        reportedAt: runDay + "T03:45:00.000Z",
        oldReadingDay: runDay,
        newReadingDay: runDay,
        oldDigestAt: runDay + "T03:20:00.000Z",
        newDigestAt: runDay + "T03:30:00.000Z",
        picks: { intersection: 2, union: 3 },
        client: "claude",
        budget: "ok",
        ...override,
      }),
    );
  const saveBackup = (
    createdAt = "2026-11-17T04:30:00.000Z",
    corrupt = false,
  ) => {
    const sections = [
      "library",
      "alphaXiv",
      "paperState",
      "quickNotes",
      "digests",
      "weeklyDigests",
      "topics",
      "projects",
      "vaultIndex",
      "ideaIndex",
      "workingPaperIndex",
      "captures",
      "vaultRequests",
      "suggestions",
      "papers",
      "paperIdentifiers",
      "paperLinks",
    ];
    const data = Object.fromEntries(sections.map((key) => [key, []]));
    const counts = Object.fromEntries(
      [...sections, "configuredTopics"].map((key) => [key, 0]),
    );
    const sha256 = createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
    return writeFile(
      backup,
      gzipSync(
        JSON.stringify({
          schemaVersion: 1,
          instanceName: config.instance.name,
          createdAt,
          counts,
          expectedCounts: counts,
          data,
          configuredTopics: [],
          sha256: corrupt ? "0".repeat(64) : sha256,
        }),
      ),
      { mode: 0o600 },
    );
  };
  return {
    vault,
    state,
    configFile,
    configText,
    backup,
    call,
    text,
    saveRun,
    saveBackup,
    useRunEvidence: (evidence: unknown) => {
      runEvidence = evidence;
    },
    fetcher,
    run,
    withoutDigest: () => {
      hasDigest = false;
    },
    staleSchema: () => {
      version--;
    },
    failIndex: () => {
      failIndex = true;
    },
  };
}

it("reports the latest five completed weekdays and gives a read-only go", async () => {
  const h = await fixture({ analytics: true });
  await Promise.all(days.map((d) => h.saveRun(d)));
  await h.saveBackup();
  const checked = await h.call("cutover", "check", "--backup", h.backup);
  expect(checked).toMatchObject({
    code: 0,
    data: { decision: "go", source: "sidecar reports", reasons: [] },
  });
  expect(checked.data.runs.map(({ day }: { day: string }) => day)).toEqual(
    [...days].reverse(),
  );
  expect(checked.data.runs[0]).toMatchObject({
    sameReadingDay: true,
    oldOnTime: true,
    newOnTime: true,
    picks: { intersection: 2, union: 3 },
    pickOverlap: 2 / 3,
    client: "claude",
    budget: "ok",
  });
  expect(
    h.fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);
  expect(
    h.fetcher.mock.calls.every(([url]) => url.hostname === "fixture.invalid"),
  ).toBe(true);
  const budget = h.fetcher.mock.calls.find(([url]) =>
    url.pathname.endsWith("/budget"),
  )![0];
  expect(budget.pathname).toBe("/api/v1/vault/budget");
  await expect(
    readFile(path.join(h.state, "write-budget.json")),
  ).rejects.toHaveProperty("code", "ENOENT");
});

it("requires both reading days to match the comparison day", async () => {
  const h = await fixture();
  await Promise.all(days.map((d) => h.saveRun(d)));
  await h.saveRun(day, { oldReadingDay: days[3], newReadingDay: days[3] });
  await h.saveBackup();
  const checked = await h.call("cutover", "check", "--backup", h.backup);
  expect(checked).toMatchObject({
    code: 1,
    data: { decision: "no-go", reasons: [expect.stringContaining(day)] },
  });
  expect(checked.data.runs[0].sameReadingDay).toBe(false);
});

function healthRun(runDay: string, number: number) {
  const run: DailyRunView = {
    id: `43d91359-fbdc-4047-a843-30e90031a4d${number}`,
    startedAt: runDay + "T02:20:00.000Z",
    targetDay: runDay,
    finishedAt: runDay + "T03:45:00.000Z",
    rowsWritten: 25,
    steps: {
      fetch: { status: "done" },
      summaries: { status: "done", client: "codex" },
      digest: { status: "done", client: "claude", fallback: true },
      sync: { status: "done" },
      legacy: { status: "skipped" },
    },
  };
  return { day: runDay, run, digestAt: runDay + "T03:29:00.000Z" };
}

it("uses run records for the new digest and reports for the old digest and overlap", async () => {
  const h = await fixture();
  await Promise.all(
    days.map((d) =>
      h.saveRun(d, {
        newReadingDay: null,
        newDigestAt: null,
        client: "codex",
        budget: "stopped",
      }),
    ),
  );
  await h.saveRun(day, { picks: { intersection: 1, union: 10 }, client: null });
  await h.saveBackup();
  h.useRunEvidence({ hasRuns: true, runs: days.map(healthRun) });
  const args = ["cutover", "check", "--backup", h.backup];
  expect(await h.call(...args)).toMatchObject({
    code: 1,
    data: {
      source: "run records",
      decision: "go with review",
      overlapReviewDays: [day],
      reasons: [],
    },
  });
  const accepted = await h.call(...args, "--accept-overlap");
  expect(accepted).toMatchObject({ code: 0, data: { decision: "go" } });
  expect(accepted.data.runs[0]).toMatchObject({
    day,
    oldOnTime: true,
    newOnTime: true,
    newReadingDay: day,
    client: "claude",
    budget: "ok",
    pickOverlap: 0.1,
  });
  expect(await h.text(...args)).toMatch(/run records.*sidecar reports/i);
});

it("fails closed for missing run records, late digests, budget stops and missing old picks", async () => {
  const h = await fixture();
  await Promise.all(days.slice(1).map((d) => h.saveRun(d)));
  await h.saveBackup();
  const runs = days.map(healthRun);
  runs[4]!.digestAt = day + "T03:31:00.000Z";
  runs[4]!.run.steps!.sync = { status: "paused", error: "budget" };
  runs[3]!.run.targetDay = days[2]!;
  runs[2]!.run = {
    ...runs[2]!.run,
    finishedAt: null,
    rowsWritten: null,
    steps: null,
  };
  runs.splice(1, 1);
  h.useRunEvidence({ hasRuns: true, runs });
  const checked = await h.call(
    "cutover",
    "check",
    "--backup",
    h.backup,
    "--accept-overlap",
  );
  expect(checked).toMatchObject({
    code: 1,
    data: { source: "run records", decision: "no-go" },
  });
  expect(checked.data.reasons).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/2026-11-12.*pick overlap.*no shadow report/i),
      expect.stringMatching(/2026-11-13.*no LitScout run record/i),
      expect.stringMatching(/2026-11-16.*completion/i),
      expect.stringMatching(/2026-11-17.*reading days/i),
      expect.stringMatching(/2026-11-18.*11:30/i),
      expect.stringMatching(/2026-11-18.*budget/i),
    ]),
  );
});

it("falls back for an older Worker and fails closed when run evidence cannot be read", async () => {
  const h = await fixture();
  await Promise.all(days.map((d) => h.saveRun(d)));
  await h.saveBackup();
  const args = ["cutover", "check", "--backup", h.backup];
  h.useRunEvidence(new Response(null, { status: 404 }));
  expect(await h.call(...args)).toMatchObject({
    code: 0,
    data: { source: "sidecar reports" },
  });
  h.useRunEvidence(new Response(null, { status: 503 }));
  expect(await h.call(...args)).toMatchObject({
    code: 1,
    data: {
      source: "unavailable",
      decision: "no-go",
      reasons: [expect.stringMatching(/could not read.*run records/i)],
    },
  });
});

it("lists every low-overlap day for sign-off and keeps no-go conditions in force", async () => {
  const h = await fixture();
  await Promise.all(days.map((d) => h.saveRun(d)));
  await h.saveRun(days[0]!, { picks: { intersection: 0, union: 3 } });
  await h.saveRun(days[1]!, { picks: { intersection: 1, union: 10 } });
  await h.saveRun(days[2]!, { picks: { intersection: 1, union: 5 } });
  await h.saveRun(days[3]!, { picks: { intersection: 0, union: 0 } });
  await h.saveBackup();
  const args = ["cutover", "check", "--backup", h.backup];

  const review = await h.call(...args);
  expect(review).toMatchObject({
    code: 1,
    data: { decision: "go with review", overlapReviewDays: [days[1], days[0]] },
  });
  expect(
    review.data.runs.map(
      (run: { pickOverlap: number | null }) => run.pickOverlap,
    ),
  ).toEqual([2 / 3, null, 0.2, 0.1, 0]);
  const output = await h.text(...args);
  expect(output).toMatch(/^GO WITH REVIEW/);
  for (const picks of ["2/3", "0/0", "1/5", "1/10", "0/3"])
    expect(output).toContain(picks);
  expect(output).toMatch(/--accept-overlap/);
  expect(await h.call(...args, "--accept-overlap")).toMatchObject({
    code: 0,
    data: { decision: "go", overlapReviewDays: [days[1], days[0]] },
  });
  await h.saveRun(day, { budget: "stopped" });
  expect(await h.call(...args, "--accept-overlap")).toMatchObject({
    code: 1,
    data: { decision: "no-go", reasons: [expect.stringMatching(/budget/i)] },
  });
});

it("gives all actionable no-go reasons for absent or failing evidence", async () => {
  const h = await fixture();
  h.staleSchema();
  await mkdir(path.join(h.vault, "Digests-new"));
  await writeFile(path.join(h.vault, "Digests-new", "old.md"), "foreign");
  await h.saveRun(day, {
    oldReadingDay: "2026-11-17",
    newDigestAt: day + "T03:31:00.000Z",
    budget: "stopped",
    client: null,
  });
  await h.saveBackup("2026-11-10T00:00:00.000Z");
  const checked = await h.call("cutover", "check", "--backup", h.backup);
  expect(checked).toMatchObject({
    code: 1,
    data: {
      decision: "no-go",
      checks: {
        doctor: { ok: false },
        vault: { ok: false },
        migrations: { ok: false },
        backup: { ok: false },
      },
    },
  });
  const reasons = checked.data.reasons.join("\n");
  for (const reason of [
    /reading day/i,
    /11:30/,
    /budget/i,
    /client/i,
    /no shadow report/i,
    /7 days/,
  ])
    expect(reasons).toMatch(reason);
});

it("rejects a recent export with an invalid checksum", async () => {
  const h = await fixture();
  await Promise.all(days.map((d) => h.saveRun(d)));
  await h.saveBackup(undefined, true);
  const checked = await h.call("cutover", "check", "--backup", h.backup);
  expect(checked).toMatchObject({
    code: 1,
    data: { reasons: [expect.stringContaining("checksum")] },
  });
});

it("requires an explicit target before previewing or writing to the vault", async () => {
  const h = await fixture();
  for (const flags of [[], ["--dry-run"]]) {
    expect(await h.call("vault", "enable-writes", ...flags)).toMatchObject({
      code: 1,
      data: { message: expect.stringContaining("--digests-dir PATH") },
    });
  }
  expect(h.fetcher).not.toHaveBeenCalled();
  expect(
    await h.call(
      "vault",
      "enable-writes",
      "--digests-dir",
      "Chosen/Digests",
      "--dry-run",
    ),
  ).toMatchObject({
    code: 0,
    data: { configEdit: { write: true, digestsDir: "Chosen/Digests" } },
  });
});

it("previews the config edit, syncs the index, digest and blocks, and leaves requests queued", async () => {
  const h = await fixture();
  const note = path.join(h.vault, "Paper.md");
  await writeFile(
    note,
    "---\ntags: [type/paper]\narxiv: '2406.09414'\n---\nMy text\n",
  );
  const preview = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
    "--dry-run",
  );
  expect(preview).toMatchObject({
    code: 0,
    data: {
      configEdit: { write: true, digestsDir: "Digests" },
      index: "planned",
    },
  });
  const digest = path.join(h.vault, "Digests", day + ".md");
  await expect(readFile(digest)).rejects.toHaveProperty("code", "ENOENT");
  expect(await readFile(note, "utf8")).not.toContain("From LitScout");
  expect(
    h.fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);

  h.fetcher.mockClear();
  const applied = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
  );
  expect(applied).toMatchObject({
    code: 0,
    data: {
      index: "uploaded",
      writes: [
        { kind: "block", path: "Paper.md", mode: "applied" },
        { kind: "digest", path: "Digests/" + day + ".md", mode: "applied" },
      ],
    },
  });
  expect(await readFile(note, "utf8")).toContain("My text");
  expect(await readFile(note, "utf8")).toContain("From LitScout");
  expect(await readFile(digest, "utf8")).toContain("Fixture digest");
  expect(await readFile(h.configFile, "utf8")).toBe(h.configText);
  await expect(readFile(path.join(h.vault, "Inbox.md"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
  expect(
    h.fetcher.mock.calls.some(([url]) =>
      /\/(claim|resolve)$/.test(url.pathname),
    ),
  ).toBe(false);
});

it("checks the digest folder without a published digest and requires explicit adoption", async () => {
  const h = await fixture();
  h.withoutDigest();
  await mkdir(path.join(h.vault, "Digests"));
  const legacy = path.join(h.vault, "Digests", "old.md");
  await writeFile(legacy, "legacy");
  const refused = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
  );
  expect(refused).toMatchObject({ code: 1 });
  expect(JSON.stringify(refused.data)).toMatch(/--adopt/);
  expect(
    h.fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);
  expect(
    await h.call(
      "vault",
      "enable-writes",
      "--digests-dir",
      "Digests",
      "--adopt",
    ),
  ).toMatchObject({
    code: 0,
  });
  expect(await readFile(legacy, "utf8")).toBe("legacy");
});

it("keeps the legacy digest for the same date even with adoption", async () => {
  const h = await fixture();
  await mkdir(path.join(h.vault, "Digests"));
  const legacy = path.join(h.vault, "Digests", day + ".md");
  const content = "legacy\n\n<!-- litscout:digest -->\n";
  await writeFile(legacy, content);
  const result = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
    "--adopt",
  );
  expect(result).toMatchObject({
    code: 1,
    data: {
      problems: [expect.stringContaining("not written by LitScout")],
      writes: [],
    },
  });
  expect(await readFile(legacy, "utf8")).toBe(content);
  expect(
    h.fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);
});

it("reports files already applied if the index upload fails", async () => {
  const h = await fixture();
  h.failIndex();
  const result = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
  );
  expect(result).toMatchObject({
    code: 1,
    data: {
      stage: "First vault sync failed",
      writes: [
        { kind: "digest", path: "Digests/" + day + ".md", mode: "applied" },
      ],
    },
  });
  expect(
    await readFile(path.join(h.vault, "Digests", day + ".md"), "utf8"),
  ).toContain("Fixture digest");
  expect(await readFile(h.configFile, "utf8")).toBe(h.configText);
});

it("stops at a hand-edited block before inspecting the target folder", async () => {
  const h = await fixture();
  const note = path.join(h.vault, "Paper.md");
  const original =
    "---\ntags: [type/paper]\narxiv: '2406.09414'\n---\nMy text\n";
  const edited = putBlock(original, "Original block").replace(
    "Original block",
    "Manual edit",
  );
  await writeFile(note, edited);
  await writeFile(path.join(h.vault, "Digests"), "not a folder");
  const refused = await h.call(
    "vault",
    "enable-writes",
    "--digests-dir",
    "Digests",
  );
  expect(refused).toMatchObject({ code: 1 });
  expect(JSON.stringify(refused.data)).toMatch(/hand-edited/i);
  expect(await readFile(note, "utf8")).toBe(edited);
  expect(
    h.fetcher.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET"),
  ).toBe(true);
});
