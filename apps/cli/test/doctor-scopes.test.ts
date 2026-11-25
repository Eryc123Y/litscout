import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { doctorCommand } from "../src/doctor-command";
import type { SetupDeps } from "../src/command-types";
import { doctorResponse } from "./helpers/doctor";

it("checks the scheduler's vault capability only for sync and warns on legacy access", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-doctor-scope-"));
  try {
    const config = defineConfig({
      instance: { publicUrl: "https://worker.example" },
    });
    let token = { scopes: ["read", "ingest"], legacyVault: false };
    const deps = {
      cwd: dir,
      dir,
      run: vi.fn(async ([command]) =>
        command === "--version" ? "4.151.0" : "Not logged in",
      ),
      flow: { token: "fixture", preflight: async () => ({ usable: true }) },
      fetch: async (input: URL) => doctorResponse(input, undefined, token),
    } as unknown as SetupDeps;
    const check = () => doctorCommand(deps, config, "fixture");
    expect((await check()).data.checks.token).toMatchObject({ ok: true });
    await mkdir(path.join(dir, "vault"));
    expect((await check()).data.checks.token).toMatchObject({
      ok: false,
      vault: false,
      hint: expect.stringContaining("read,ingest,vault"),
    });
    token = { scopes: ["read", "ingest"], legacyVault: true };
    const legacy = await check();
    expect(legacy.data.checks.token).toMatchObject({ ok: true, vault: true });
    expect(legacy.data.warnings).toContainEqual(
      expect.stringMatching(/rotate.*read,ingest,vault/i),
    );
    token = { scopes: ["read", "ingest", "vault"], legacyVault: false };
    const rotated = await check();
    expect(rotated.data.checks.token).toMatchObject({ ok: true, vault: true });
    expect(rotated.data.warnings).not.toContainEqual(
      expect.stringMatching(/rotate/i),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
