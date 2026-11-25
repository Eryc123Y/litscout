import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { privateJson, secureDir } from "./state";
import { UsageError } from "./command-types";
const credentialSchema = z.object({
  id: z.string(),
  token: z.string(),
  name: z.string(),
  url: z.string().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});
const storeSchema = z.object({ tokens: z.array(credentialSchema) });
export type Credential = z.infer<typeof credentialSchema>;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export async function removeStaleLock(file: string, staleMs: number) {
  try {
    const before = await stat(file);
    if (Date.now() - before.mtimeMs < staleMs) return;
    const content = await readFile(file, "utf8").then((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return {};
      }
    });
    const pid = z
      .number()
      .int()
      .positive()
      .safeParse(
        typeof content === "object" && content ? content.pid : content,
      );
    if (pid.success && alive(pid.data)) return;
    const after = await stat(file);
    if (after.ino === before.ino && after.mtimeMs === before.mtimeMs)
      await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function withCredentialsLock<T>(
  dir: string,
  work: () => Promise<T>,
  options = { staleMs: 60_000, waitMs: 5000 },
): Promise<T> {
  await secureDir(dir);
  const file = path.join(dir, "credentials.json.lock");
  const deadline = Date.now() + options.waitMs;
  while (true) {
    let lock;
    try {
      lock = await open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(file, options.staleMs).catch(() => {
        throw new UsageError("Cannot inspect credentials lock");
      });
      if (Date.now() >= deadline)
        throw new UsageError(
          "Credentials are locked by another process; retry shortly",
        );
      await pause(20);
      continue;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      return await work();
    } finally {
      await lock.close();
      await unlink(file);
    }
  }
}
async function stored(dir: string) {
  try {
    return storeSchema.parse(
      JSON.parse(await readFile(path.join(dir, "credentials.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { tokens: [] };
    throw new UsageError("Cannot read existing local token store");
  }
}
export async function addCredential(dir: string, entry: Credential) {
  return withCredentialsLock(dir, async () => {
    const previous = await stored(dir);
    await privateJson(path.join(dir, "credentials.json"), {
      tokens: [...previous.tokens, credentialSchema.parse(entry)],
    });
  });
}
export async function removeCredential(dir: string, id: string) {
  return withCredentialsLock(dir, async () => {
    const previous = await stored(dir);
    await privateJson(path.join(dir, "credentials.json"), {
      tokens: previous.tokens.filter((token) => token.id !== id),
    });
  });
}
