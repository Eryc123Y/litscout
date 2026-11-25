import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { legacyCommand } from "../src/legacy-command";
import type { FlowDeps } from "../src/flow-runtime";
const deps = {
  cwd: "/",
  flow: {
    now: () => new Date("2026-11-17"),
    git: async (_repo: string, args: string[]) =>
      args[0] === "ls-tree" ? "" : "ref",
  },
} as FlowDeps;
it("S6 refuses symlinked digest folders, digest directories and files", async () => {
  const root = await mkdtemp(
      path.join(await realpath(tmpdir()), "litscout-privacy-"),
    ),
    folder = path.join(root, "folder"),
    outside = path.join(root, "outside");
  try {
    await mkdir(folder);
    await mkdir(outside);
    await writeFile(path.join(outside, "private.md"), "SYNTHETIC_PRIVATE_DATA");
    await symlink(outside, path.join(root, "linked"));
    await expect(
      legacyCommand(
        ["--repo", root, "--dir", path.join(root, "linked"), "--dry-run"],
        deps,
      ),
    ).rejects.toThrow(/symlink/i);
    await symlink(outside, path.join(folder, "digests"));
    await expect(
      legacyCommand(["--repo", root, "--dir", folder, "--dry-run"], deps),
    ).rejects.toThrow(/symlink/i);
    await rm(path.join(folder, "digests"));
    await mkdir(path.join(folder, "digests"));
    await symlink(
      path.join(outside, "private.md"),
      path.join(folder, "digests", "2026-11-17.md"),
    );
    await expect(
      legacyCommand(["--repo", root, "--dir", folder, "--dry-run"], deps),
    ).rejects.toThrow(/symlink/i);
    await rm(path.join(folder, "digests", "2026-11-17.md"));
    await symlink(
      path.join(outside, "private.md"),
      path.join(folder, "feedback.md"),
    );
    await expect(
      legacyCommand(["--repo", root, "--dir", folder, "--dry-run"], deps),
    ).rejects.toThrow(/symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
