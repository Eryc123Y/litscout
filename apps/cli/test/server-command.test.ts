import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCommand, type SetupDeps } from "../src/setup-commands";

// `server report FILE` sends the own server's facts (housekeep.py
// --status-file) to the Worker for Health and doctor.
const status = {
  checkedAt: "2026-11-22T13:50:00Z",
  footprintBytes: 2_800_000_000,
  warningBytes: 4 * 1024 ** 3,
  capBytes: 5 * 1024 ** 3,
  snapshot: { at: "2026-11-22T04:30:12Z", bytes: 6_800_000 },
  runs: [{ mode: "final", startedAt: "2026-11-22T13:45:00Z", failed: false }],
};
async function withConfig(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "litscout-server-"));
  try {
    await writeFile(
      join(dir, "litscout.config.ts"),
      'export default {instance:{publicUrl:"https://worker.example"}};',
    );
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const depsFor = (dir: string, fetch: unknown, print = vi.fn()) =>
  ({
    dir,
    cwd: dir,
    print,
    fetch,
    flow: { token: "fixture" },
  }) as unknown as SetupDeps;

it("sends the status file with PUT", async () => {
  await withConfig(async (dir) => {
    const file = join(dir, "status.json");
    await writeFile(file, JSON.stringify(status));
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.href).toBe(
        "https://worker.example/api/v1/ingest/server-status",
      );
      expect(init.method).toBe("PUT");
      expect(JSON.parse(String(init.body))).toEqual(status);
      return Response.json({ success: true, data: { stored: true } });
    });
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "report", file, "--json"],
        depsFor(dir, fetch, print),
      ),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(print.mock.calls[0]![0]).data).toEqual({
      stored: true,
      checkedAt: status.checkedAt,
    });
  });
});

it("refuses a file that is not a server status, without a request", async () => {
  await withConfig(async (dir) => {
    const file = join(dir, "status.json");
    await writeFile(file, JSON.stringify({ ...status, capBytes: "5 GB" }));
    const fetch = vi.fn();
    expect(
      await runCommand(
        ["server", "report", file, "--json"],
        depsFor(dir, fetch),
      ),
    ).not.toBe(0);
    expect(
      await runCommand(["server", "--json"], depsFor(dir, fetch)),
    ).not.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("says when the Worker refuses the report", async () => {
  await withConfig(async (dir) => {
    const file = join(dir, "status.json");
    await writeFile(file, JSON.stringify(status));
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "report", file, "--json"],
        depsFor(dir, fetch, print),
      ),
    ).not.toBe(0);
    expect(print.mock.calls.flat().join("\n")).toContain("HTTP 403");
  });
});
