import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { doctorCommand } from "../src/doctor-command";
import type { SetupDeps } from "../src/command-types";
import { doctorResponse } from "./helpers/doctor";

// On an own server (the Worker reports runtime "server"), doctor skips the
// Cloudflare-only checks (Wrangler, D1 usage and reconciliation, the 500 MB
// D1 limit, token listing through Wrangler) and checks the server's facts:
// storage against the cap, the newest snapshot and the newest runs.
const GB = 1024 ** 3;
// One "now" for the whole file: two clock reads could fall on either side of
// a second and make the expected facts differ from the stored ones (11-25).
const now = Date.now();
const hoursAgo = (hours: number) =>
  new Date(now - hours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
const facts = (overrides: Record<string, unknown> = {}) => ({
  checkedAt: hoursAgo(1),
  footprintBytes: Math.round(2.8 * GB),
  warningBytes: 4 * GB,
  capBytes: 5 * GB,
  snapshot: { at: hoursAgo(12), bytes: 6_800_000 },
  runs: [
    { mode: "main", startedAt: hoursAgo(12), failed: false },
    { mode: "retry", startedAt: hoursAgo(8), failed: false },
    { mode: "final", startedAt: hoursAgo(1), failed: false },
  ],
  ...overrides,
});
async function doctor(
  server: unknown,
  runtime = "server",
  publicUrl = "https://worker.example",
  details: Record<string, unknown> = {},
) {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-doctor-server-"));
  try {
    const run = vi.fn(async () => {
      throw new Error("Wrangler is not used on an own server");
    });
    const deps = {
      cwd: dir,
      dir,
      run,
      flow: { token: "fixture", preflight: async () => ({ usable: true }) },
      fetch: async (input: URL) =>
        doctorResponse(input, undefined, undefined, {
          runtime,
          server,
          ...details,
        }),
    } as unknown as SetupDeps;
    const config = defineConfig({
      instance: { publicUrl },
      agent: { mode: "none" },
    });
    return { result: await doctorCommand(deps, config, "fixture"), run };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("passes on a healthy server without Wrangler and shows its facts", async () => {
  const { result, run } = await doctor(facts());
  const failing = Object.entries(result.data.checks).filter(
    ([, check]) => !(check as { ok: boolean }).ok,
  );
  expect(failing).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect(result.failed).toBe(false);
  expect(result.data).toMatchObject({
    runtime: "server",
    server: facts(),
    usage: null,
    reconciliation: null,
    tokensChecked: false,
    retention: { databaseLimitBytes: null },
    checks: {
      wrangler: { ok: true, notUsed: "own server" },
      wranglerLogin: { ok: true, notUsed: "own server" },
      storage: {
        ok: true,
        footprintBytes: Math.round(2.8 * GB),
        capBytes: 5 * GB,
      },
    },
  });
  expect(result.data.warnings.join("\n")).not.toMatch(/D1|Wrangler/);
});

it("warns at the warning level, about an old snapshot, a failed run or a stale report", async () => {
  const { result } = await doctor(
    facts({
      checkedAt: hoursAgo(40),
      footprintBytes: 4.5 * GB,
      snapshot: { at: hoursAgo(50), bytes: 6_800_000 },
      runs: [{ mode: "final", startedAt: hoursAgo(40), failed: true }],
    }),
  );
  expect(result.failed).toBe(false);
  const warnings = result.data.warnings.join("\n");
  expect(warnings).toContain("Server storage at 4.5 GB (warning level 4 GB)");
  expect(warnings).toMatch(/newest snapshot is \d+ hours old/i);
  expect(warnings).toMatch(/last final run .* failed step/i);
  expect(warnings).toMatch(/server last reported \d+ hours ago/i);
});

it("fails over the cap and warns before the first report", async () => {
  const over = await doctor(facts({ footprintBytes: 5.5 * GB }));
  expect(over.result.failed).toBe(true);
  expect(over.result.data.checks.storage).toMatchObject({
    ok: false,
    hint: expect.stringContaining("housekeep.py"),
  });
  const fresh = await doctor(null);
  expect(fresh.result.data.warnings).toContainEqual(
    expect.stringMatching(/not reported its status yet/i),
  );
  expect(fresh.result.data.checks.storage).toMatchObject({ ok: true });
});

it("keeps the Cloudflare checks when the Worker runs on Cloudflare", async () => {
  const { result, run } = await doctor(null, "cloudflare");
  expect(run).toHaveBeenCalledWith(["--version"]);
  expect(result.data.runtime).toBe("cloudflare");
  expect(result.data.checks).not.toHaveProperty("storage");
  expect(result.data.retention.databaseLimitBytes).toBe(500_000_000);
});

it("still knows it is on a server when the report does not parse", async () => {
  const { result, run } = await doctor({ ...facts(), footprintBytes: -1 });
  expect(run).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({ runtime: "server", server: null });
});

it("checks the server through its loopback address before it has a public one", async () => {
  const { result, run } = await doctor(
    facts(),
    "server",
    "http://127.0.0.1:8787",
  );
  expect(run).not.toHaveBeenCalled();
  expect(result.data.runtime).toBe("server");
  expect(result.data.checks).toMatchObject({
    worker: { ok: true },
    health: { ok: true },
    token: { ok: true },
  });
});

it("says a trial needs no sign-in, and only when the server says it is one", async () => {
  const local = "http://127.0.0.1:8787";
  const access = async (details?: Record<string, unknown>) =>
    (await doctor(facts(), "server", local, details)).result.data.checks.access;
  // A trial has no scheduled runs: a missing server report is no warning.
  const unreported = async (details?: Record<string, unknown>) =>
    (await doctor(null, "server", local, details)).result.data.warnings.filter(
      (warning: string) => warning.includes("not reported"),
    ).length;
  expect(await unreported({ trial: true })).toBe(0);
  expect(await unreported()).toBe(1);
  expect(await access({ trial: true })).toEqual({
    ok: true,
    configured: false,
    message:
      "A trial on this computer: the reader at http://127.0.0.1:8787/app needs no sign-in.",
  });
  // A server checked on its own port before it has a public address
  // (server guide, step 8) has the same address and still needs Access.
  expect((await access()).message).toContain("Access is disabled");
});
