import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { writeEvidence } from "./evidence";

it("requires explicit evidence opt-in and creates a missing directory when enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "litscout-evidence-"));
  const directory = join(root, "missing", "evidence");
  try {
    for (const value of [undefined, "0", "true"]) {
      vi.stubEnv("LITSCOUT_EVIDENCE", value);
      await writeEvidence("result.json", { passed: true }, directory);
      await expect(stat(directory)).rejects.toHaveProperty("code", "ENOENT");
    }
    vi.stubEnv("LITSCOUT_EVIDENCE", "1");
    await writeEvidence("result.json", { passed: true }, directory);
    expect(
      JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
    ).toEqual({ passed: true });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
