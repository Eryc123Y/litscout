import { lstat, open, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
async function noSymlinks(value: string) {
  let at = path.parse(value).root;
  for (const component of value
    .slice(at.length)
    .split(path.sep)
    .filter(Boolean)) {
    at = path.join(at, component);
    if ((await lstat(at)).isSymbolicLink())
      throw new Error("Legacy digest input must not follow symlinks");
  }
}
async function readPrivate(file: string) {
  await noSymlinks(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Legacy digest input must be a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
export async function digestFolder(directory?: string) {
  if (!directory) return {};
  await noSymlinks(directory);
  const files: Record<string, string> = {};
  for (const name of [
    "ledger.json",
    "project-radar.md",
    "missed.md",
    "feedback.md",
  ]) {
    try {
      files[name] = await readPrivate(path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const digests = path.join(directory, "digests");
  try {
    await noSymlinks(digests);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const name of await readdir(digests))
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      files[`digests/${name}`] = await readPrivate(path.join(digests, name));
  return files;
}
