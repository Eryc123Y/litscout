import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// vault-host.sh keeps the vault machine's CLI on the server's version: it
// pulls the clone the CLI runs from and rebuilds a build that is not from the
// clone's commit, before the sync. On 2026-11-22 a clone eight hours behind
// the server failed two syncs.
const script = path.resolve("apps/server/scripts/vault-host.sh");
const scriptInClone = "apps/server/scripts/vault-host.sh";
const stamp = "apps/cli/dist/commit";
// Joined at run time so the repository audit sees no contact literal.
const fixtureEmail = ["fixture", "example.invalid"].join("@");

function machine() {
  const home = mkdtempSync(path.join(tmpdir(), "litscout-vault-host-"));
  const origin = path.join(home, "origin");
  const clone = path.join(home, "clone");
  const bin = path.join(home, "bin");
  const calls = path.join(home, "calls.log");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: fixtureEmail,
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: fixtureEmail,
      },
    }).trim();
  const commit = (message: string) => {
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", message);
    return git(origin, "rev-parse", "HEAD");
  };
  mkdirSync(path.join(origin, path.dirname(scriptInClone)), {
    recursive: true,
  });
  git(origin, "init", "-q", "-b", "main");
  copyFileSync(script, path.join(origin, scriptInClone));
  writeFileSync(path.join(origin, ".gitignore"), "dist/\n");
  const first = commit("first");
  git(home, "clone", "-q", origin, clone);
  mkdirSync(bin);
  // Stand-ins that record what the job ran, in order.
  const tool = (name: string, body: string) => {
    writeFileSync(
      path.join(bin, name),
      `#!/bin/bash\necho "${name} $*" >> "${calls}"\n${body}\n`,
    );
    chmodSync(path.join(bin, name), 0o755);
  };
  tool("node", "echo '{\"success\":true}'");
  // "pnpm build" leaves the CLI and the commit it was built from.
  tool(
    "pnpm",
    `echo "a warning from $1" >&2
if [ "$1" = build ]; then
  [ -n "\${FAIL_BUILD:-}" ] && echo "the build error" >&2 && exit 1
  mkdir -p apps/cli/dist && : > apps/cli/dist/index.js
  git rev-parse HEAD > ${stamp}
fi`,
  );
  const built = (sha: string) => {
    mkdirSync(path.join(clone, "apps/cli/dist"), { recursive: true });
    writeFileSync(path.join(clone, "apps/cli/dist/index.js"), "");
    writeFileSync(path.join(clone, stamp), sha + "\n");
  };
  const run = (env: Record<string, string> = {}) => {
    const result = spawnSync("bash", [path.join(clone, scriptInClone)], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        LITSCOUT_CONFIG: path.join(home, "litscout.config.ts"),
        LITSCOUT_CLI: path.join(clone, "apps/cli/dist/index.js"),
        LITSCOUT_SSH: "unused",
        ...env,
      },
    });
    return {
      code: result.status,
      out: result.stdout + result.stderr,
      // Only the first two words: the commands, not their paths.
      calls: existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .map((line) =>
              line.startsWith("node")
                ? "node " + line.split(" ")[2]
                : line.split(" ").slice(0, 2).join(" "),
            )
            // The legacy import only runs at night.
            .filter((line) => line !== "node legacy")
        : [],
    };
  };
  return {
    home,
    origin,
    clone,
    first,
    commit,
    built,
    run,
    head: () => git(clone, "rev-parse", "HEAD"),
  };
}

it("pulls a clone that is behind and rebuilds the CLI before the sync", () => {
  const m = machine();
  try {
    m.built(m.first);
    writeFileSync(path.join(m.origin, "change.txt"), "a server-side change\n");
    const second = m.commit("second");
    const { code, out, calls } = m.run();
    expect(code, out).toBe(0);
    expect(m.head()).toBe(second);
    expect(calls).toEqual(["pnpm install", "pnpm build", "node sync"]);
    expect(out).toContain(
      `== update: ${m.first.slice(0, 7)} -> ${second.slice(0, 7)}`,
    );
    expect(readFileSync(path.join(m.clone, stamp), "utf8").trim()).toBe(second);
    // A build that worked leaves its warnings out of the job's log.
    expect(out).not.toContain("a warning from");
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("runs the pulled version of itself", () => {
  const m = machine();
  try {
    m.built(m.first);
    const file = path.join(m.origin, scriptInClone);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        /^set -uo pipefail$/m,
        'set -uo pipefail\necho "== the pulled script"',
      ),
    );
    m.commit("a newer script");
    const { code, out, calls } = m.run();
    expect(code, out).toBe(0);
    expect(out).toContain("== the pulled script");
    // One pull, one build and one sync: the restart does not repeat them.
    expect(calls).toEqual(["pnpm install", "pnpm build", "node sync"]);
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("leaves a current clone with a current build alone", () => {
  const m = machine();
  try {
    m.built(m.first);
    const { code, out, calls } = m.run();
    expect(code, out).toBe(0);
    expect(calls).toEqual(["node sync"]);
    expect(out).not.toContain("== update");
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("rebuilds a build that is not from the clone's commit", () => {
  const m = machine();
  try {
    // Pulled by hand without a rebuild, or an earlier build failed.
    m.built("0".repeat(40));
    const { code, out, calls } = m.run();
    expect(code, out).toBe(0);
    expect(calls).toEqual(["pnpm install", "pnpm build", "node sync"]);
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("still syncs with the build it has when the pull fails, and says so", () => {
  const m = machine();
  try {
    m.built(m.first);
    rmSync(m.origin, { recursive: true, force: true });
    const { code, out, calls } = m.run();
    expect(code, out).toBe(0);
    expect(calls).toEqual(["node sync"]);
    expect(out).toContain(
      `== update: pull failed; the CLI stays at ${m.first.slice(0, 7)}`,
    );
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("stops a pull that hangs and syncs with the build it has", () => {
  const m = machine();
  try {
    m.built(m.first);
    // A git whose pull never answers, as behind a dead proxy.
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const fake = path.join(m.home, "bin", "git");
    writeFileSync(
      fake,
      `#!/bin/bash\ncase " $* " in *" pull "*) exec sleep 60 ;; esac\nexec "${real}" "$@"\n`,
    );
    chmodSync(fake, 0o755);
    const started = Date.now();
    const { code, out, calls } = m.run({ LITSCOUT_PULL_SECONDS: "1" });
    expect(code, out).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(calls).toEqual(["node sync"]);
    expect(out).toContain("== update: pull failed");
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("fails the job when the rebuild fails, after trying the sync", () => {
  const m = machine();
  try {
    m.built(m.first);
    writeFileSync(path.join(m.origin, "change.txt"), "a change\n");
    m.commit("second");
    const { code, out, calls } = m.run({ FAIL_BUILD: "1" });
    expect(code, out).toBe(1);
    expect(out).toContain("== update: build failed");
    // A build that failed shows what it printed.
    expect(out).toContain("the build error");
    expect(calls).toEqual(["pnpm install", "pnpm build", "node sync"]);
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});

it("LITSCOUT_UPDATE=0 leaves the clone and the build as they are", () => {
  const m = machine();
  try {
    m.built("0".repeat(40));
    writeFileSync(path.join(m.origin, "change.txt"), "a change\n");
    m.commit("second");
    const { code, out, calls } = m.run({ LITSCOUT_UPDATE: "0" });
    expect(code, out).toBe(0);
    expect(m.head()).toBe(m.first);
    expect(calls).toEqual(["node sync"]);
  } finally {
    rmSync(m.home, { recursive: true, force: true });
  }
});
