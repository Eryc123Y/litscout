import { execFileSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const script = path.resolve("apps/server/scripts/notify.py");
const line = (step: string, exit: number, data: unknown, success = true) =>
  JSON.stringify({
    step,
    started: "2026-11-23T01:45:00Z",
    exit,
    output: JSON.stringify({ success, data }),
  });
function notify(lines: string[], mode: string, home?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-notify-"));
  const log = path.join(dir, "run.jsonl");
  writeFileSync(log, lines.join("\n") + "\n");
  const homeArgs = home ? ["--home", home] : [];
  return execFileSync(
    "python3",
    ["-I", script, log, mode, ...homeArgs, "--dry-run"],
    { encoding: "utf8" },
  );
}
/** A home folder holding one sparse file of the given apparent size. */
function homeOf(gigabytes: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-notify-home-"));
  mkdirSync(path.join(dir, "litscout"));
  const fd = openSync(path.join(dir, "litscout", "big"), "w");
  ftruncateSync(fd, Math.round(gigabytes * 1024 ** 3));
  closeSync(fd);
  return dir;
}

it("stays quiet when a run needs nothing from the owner", () => {
  expect(
    notify(
      [
        line("start", 0, { targetDay: "2026-11-23" }),
        line("fetch", 0, { status: "pending", day: "2026-11-23" }),
        line("summaries", 2, { status: "no-new-batch", day: "2026-11-23" }),
        line("digest", 0, {
          status: "written",
          day: "2026-11-23",
          clientsUsed: ["antigravity"],
          fallback: [],
        }),
      ],
      "final",
    ),
  ).toBe("");
});

it("lists failures, login checks and fallbacks once each", () => {
  const out = notify(
    [
      line("fetch", 1, { message: "Crawl deadline reached" }, false),
      line("summaries", 0, {
        status: "done",
        day: "2026-11-23",
        clientsUsed: ["antigravity", "codex"],
        preflight: [
          { client: "antigravity", usable: false, reason: "not authenticated" },
          { client: "codex", usable: true, reason: "ready" },
        ],
        fallback: [{ from: "antigravity", to: "codex", reason: "login" }],
      }),
      line("digest", 0, {
        status: "paused",
        day: "2026-11-23",
        preflight: [
          { client: "antigravity", usable: false, reason: "not authenticated" },
        ],
      }),
    ],
    "main",
  );
  expect(out).toContain("LitScout main run (2026-11-23)");
  expect(out).toContain("- fetch failed: Crawl deadline reached");
  expect(out).toContain("- antigravity login check failed: not authenticated");
  expect(out).toContain(
    "- summaries fell back from antigravity to codex: login",
  );
  expect(out).toContain("- digest paused: a client's usage limit was reached");
  expect(out.match(/login check failed/g)).toHaveLength(1);
});

it("does not report a run that stopped at its chunk limit; the next run continues", () => {
  expect(
    notify(
      [
        line("summaries 2026-11-17", 0, {
          status: "paused",
          day: "2026-11-17",
          stopped: "chunk budget",
          clientsUsed: ["antigravity"],
          fallback: [],
        }),
      ],
      "retry",
    ),
  ).toBe("");
});
it("reports a day without a digest only after the final run", () => {
  const lines = [
    line("digest", 0, { status: "summaries-pending", day: "2026-11-23" }),
  ];
  expect(notify(lines, "retry")).toBe("");
  expect(notify(lines, "final")).toContain(
    "no digest for 2026-11-23 after the last retry (summaries-pending)",
  );
});

it("warns at 4 GB and says when the home is over the 5 GB cap", () => {
  const done = [line("start", 0, { targetDay: "2026-11-23" })];
  expect(notify(done, "final", homeOf(3.5))).toBe("");
  expect(notify(done, "final", homeOf(4.5))).toContain(
    "- storage at 4.5 GB (warning level 4 GB)",
  );
  const over = notify(done, "final", homeOf(5.5));
  expect(over).toContain("- storage at 5.5 GB, over the 5 GB cap");
  expect(over).not.toContain("warning level");
});
