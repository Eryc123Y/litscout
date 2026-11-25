import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// daily-run.sh with a stand-in CLI: which steps a run logs, and that the
// final run keeps the server's files within their limits.
const scripts = path.resolve("apps/server/scripts");

function server() {
  const home = mkdtempSync(path.join(tmpdir(), "litscout-run-"));
  const base = path.join(home, "litscout");
  const bin = path.join(home, "bin");
  mkdirSync(path.join(base, "releases", "r1", "dist"), { recursive: true });
  symlinkSync(path.join(scripts), path.join(base, "releases", "r1", "scripts"));
  symlinkSync(path.join(base, "releases", "r1"), path.join(base, "current"));
  mkdirSync(bin);
  // The CLI: every command succeeds; the budget is spent, so no catch-up.
  const node = path.join(bin, "fake-node");
  writeFileSync(
    node,
    `#!/usr/bin/env bash
shift
case "$1 $2" in
  "budget "*) echo '{"success":true,"data":{"limit":10,"used":10}}' ;;
  "daily status") echo '{"success":true,"data":[]}' ;;
  *) echo '{"success":true,"data":{"status":"done"}}' ;;
esac
`,
  );
  // macOS has no flock; the lock itself is not under test here.
  writeFileSync(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(node, 0o755);
  chmodSync(path.join(bin, "flock"), 0o755);
  return { home, base, bin, node };
}
function run(
  mode: string,
  { homeGigabytes = 0, timezone = "", sundayIn = "", quote = '"' } = {},
) {
  const s = server();
  if (sundayIn) {
    const real = execFileSync("bash", ["-c", "command -v date"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      path.join(s.bin, "date"),
      `#!/usr/bin/env bash\nif [ "$1" = "+%u" ]; then [ "$TZ" = "${sundayIn}" ] && echo 7 || echo 3; exit 0; fi\nexec ${real} "$@"\n`,
    );
    chmodSync(path.join(s.bin, "date"), 0o755);
  }
  if (timezone !== "") {
    mkdirSync(path.join(s.base, "etc"), { recursive: true });
    writeFileSync(
      path.join(s.base, "etc", "litscout.config.ts"),
      `export default {\n  instance: {\n    timezone: ${quote}${timezone}${quote},\n  },\n};\n`,
    );
  }
  if (homeGigabytes) {
    // A sparse file: its apparent size counts, nothing is written.
    const fd = openSync(path.join(s.base, "state.sqlite"), "w");
    ftruncateSync(fd, homeGigabytes * 1024 ** 3);
    closeSync(fd);
  }
  execFileSync("bash", [path.join(scripts, "daily-run.sh"), mode], {
    env: {
      PATH: `${s.bin}:${process.env.PATH}`,
      HOME: s.home,
      LITSCOUT_NODE: s.node,
      ...(timezone === "" ? { LITSCOUT_TZ: "UTC" } : {}),
    },
    encoding: "utf8",
  });
  const logs = path.join(s.base, "logs");
  const log = readdirSync(logs).find((name) => name.startsWith("run-"))!;
  return readFileSync(path.join(logs, log), "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { step: string; exit: number; output: string },
    );
}

it("ends the final run with the housekeeper over the user's home", () => {
  const steps = run("final");
  const names = steps.map((s) => s.step);
  expect(names.indexOf("housekeep")).toBeGreaterThan(names.indexOf("prune"));
  expect(names.indexOf("housekeep")).toBeLessThan(names.indexOf("report"));
  const housekeep = steps.find((s) => s.step === "housekeep")!;
  expect(housekeep.exit).toBe(0);
  expect(JSON.parse(housekeep.output)).toMatchObject({
    success: true,
    data: { dryRun: false, overCap: false, removed: [] },
  });
  expect(names).not.toContain("prune over cap");
});

it("over the cap after the file limits, prunes the oldest compact week", () => {
  const names = run("final", { homeGigabytes: 6 }).map((s) => s.step);
  expect(names.indexOf("prune over cap")).toBe(names.indexOf("housekeep") + 1);
});

it("leaves the housekeeping to the final run", () => {
  const names = run("main").map((s) => s.step);
  expect(names).toContain("report");
  expect(names).not.toContain("housekeep");
});

it("reports the server's facts at the end of every run", () => {
  for (const mode of ["main", "final"]) {
    const steps = run(mode);
    expect(steps.at(-1)).toMatchObject({ step: "server status", exit: 0 });
    expect(steps.map((s) => s.step).indexOf("report")).toBe(steps.length - 2);
  }
});

it("captures and mirrors the alphaXiv library once a day, in the final run", () => {
  const final = run("final").map((s) => s.step);
  expect(final.indexOf("alphaxiv")).toBeGreaterThan(final.indexOf("links"));
  expect(final.indexOf("alphaxiv")).toBeLessThan(final.indexOf("prune"));
  expect(run("main").map((s) => s.step)).not.toContain("alphaxiv");
});

it("decides Sunday's weekly summary in the instance's own time zone", () => {
  // A stand-in date(1): Sunday in one zone, Wednesday everywhere else.
  for (const [timezone, sunday, quote] of [
    ["Pacific/Kiritimati", true, '"'],
    ["Pacific/Kiritimati", true, "'"],
    ["Pacific/Pago_Pago", false, '"'],
  ] as const) {
    const names = run("final", {
      timezone,
      quote,
      sundayIn: "Pacific/Kiritimati",
    }).map((step) => step.step);
    expect(names.includes("weekly"), timezone).toBe(sunday);
  }
});

it("ships timers in UTC, at the instants the owner's server has used", () => {
  const deploy = path.resolve("apps/server/deploy");
  const calendar = (name: string) =>
    readFileSync(path.join(deploy, name), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("OnCalendar="))
      .map((line) => line.slice("OnCalendar=".length));
  expect(calendar("litscout-daily-main.timer")).toEqual(["*-*-* 01:45:00 UTC"]);
  expect(calendar("litscout-daily-retry.timer")).toEqual([
    "*-*-* 06:30:00 UTC",
    "*-*-* 08:30:00 UTC",
  ]);
  expect(calendar("litscout-daily-final.timer")).toEqual([
    "*-*-* 13:45:00 UTC",
  ]);
  expect(calendar("litscout-snapshot.timer")).toEqual(["*-*-* 20:30:00 UTC"]);
  expect(calendar("litscout-clients-check.timer")).toEqual([
    "*-*-* 12:30:00 UTC",
  ]);
  expect(calendar("litscout-clients-update.timer")).toEqual([
    "Sun *-*-* 21:30:00 UTC",
  ]);
});
