import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { doctorCommand } from "../src/doctor-command";
import type { SetupDeps } from "../src/command-types";
import { doctorResponse } from "./helpers/doctor";

const publicUrl = "https://worker.example";
const unused = expect.stringContaining("profile is not read by LitScout");

async function doctorWarnings(profile?: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-doctor-profile-"));
  try {
    const deps = {
      cwd: dir,
      dir,
      run: vi.fn(async ([command]) =>
        command === "--version" ? "4.151.0" : "Not logged in",
      ),
      flow: { token: "fixture", preflight: async () => ({ usable: true }) },
      fetch: async (input: URL) => doctorResponse(input),
    } as unknown as SetupDeps;
    const result = await doctorCommand(
      deps,
      defineConfig({ instance: { publicUrl }, ...(profile && { profile }) }),
      "fixture",
    );
    return result.data.warnings as string[];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("does not warn about profile when it is left at its defaults", async () => {
  expect(await doctorWarnings()).not.toContainEqual(unused);
  expect(await doctorWarnings({})).not.toContainEqual(unused);
});

it("warns that a configured profile section is not read", async () => {
  const included = await doctorWarnings({ include: ["Research/*.md"] });
  expect(included).toContainEqual(unused);
  expect(included).toContainEqual(expect.stringContaining("vault.exclude"));
  expect(included).toContainEqual(
    expect.stringContaining("research.contextBodies"),
  );
  expect(included).toContainEqual(expect.stringContaining("vault.ideaTag"));
  expect(await doctorWarnings({ exclude: ["Private/**"] })).toContainEqual(
    unused,
  );
  expect(
    await doctorWarnings({ kinds: { "Research/*.md": "project" } }),
  ).toContainEqual(unused);
  expect(await doctorWarnings({ root: "../notes" })).toContainEqual(unused);
});

it("leaves the profile section out of the self-host template", async () => {
  const template = await readFile(
    fileURLToPath(
      new URL(
        "../../../templates/self-host/litscout.config.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  expect(template).not.toMatch(/^\s*profile\s*:/m);
  expect(template).toContain('exclude: ["**/.*", "**/*NDA*"');
});
