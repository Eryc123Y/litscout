import { mkdtemp, rm, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  readCheckpoint,
  resumeDirectory,
  writeCheckpoint,
} from "../src/checkpoint-store";
it("W3 checkpoints are private and isolated by instance, and reject invalid, oversized or linked files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-checkpoint-"));
  try {
    const a = await resumeDirectory(dir, "https://first.example"),
      b = await resumeDirectory(dir, "https://second.example");
    expect(a).not.toBe(b);
    expect((await stat(a)).mode & 0o777).toBe(0o700);
    const file = path.join(a, "test.json"),
      schema = z.object({ offset: z.number().int() });
    expect(await readCheckpoint(file, schema)).toBeNull();
    await writeFile(file, '{"offset":1}');
    expect(await readCheckpoint(file, schema)).toEqual({ offset: 1 });
    await expect(writeCheckpoint(file, { offset: 2 }, 1)).rejects.toThrow(
      "oversized",
    );
    expect(await readCheckpoint(file, schema)).toEqual({ offset: 1 });
    await expect(readCheckpoint(file, schema, 1)).rejects.toThrow("oversized");
    const link = path.join(a, "link.json");
    await symlink(file, link);
    await expect(readCheckpoint(link, schema)).rejects.toThrow("Invalid");
    await writeFile(file, '{"offset":"invalid"}');
    await expect(readCheckpoint(file, schema)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
