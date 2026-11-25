import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCredentialsLock } from "../src/credentials-store";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-lock-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "credentials.json.lock") };
}
it.each(["", "null"])(
  "recovers an old incomplete lock left by a crash: %s",
  async (content) => {
    const { dir, file } = await fixture();
    await writeFile(file, content);
    await utimes(file, new Date(0), new Date(0));
    expect(await withCredentialsLock(dir, async () => 42)).toBe(42);
    await expect(stat(file)).rejects.toThrow();
  },
);
it("does not steal a live owner's lock even when its timestamp is old", async () => {
  const { dir, file } = await fixture();
  await writeFile(file, JSON.stringify({ pid: process.pid }));
  await utimes(file, new Date(0), new Date(0));
  await expect(
    withCredentialsLock(dir, async () => 42, { staleMs: 1, waitMs: 25 }),
  ).rejects.toThrow(/locked/);
  expect((await stat(file)).isFile()).toBe(true);
});
it("releases the lock when a local write fails", async () => {
  const { dir, file } = await fixture();
  await expect(
    withCredentialsLock(dir, async () => {
      throw new Error("write failed");
    }),
  ).rejects.toThrow("write failed");
  await expect(stat(file)).rejects.toThrow();
});
