import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { FlowDeps } from "./flow-runtime";

const hour = 3600000;
const startedAt = Math.round(Date.now() - process.uptime() * 1000);
const pidSchema = z.number().int().positive().max(2147483647);
const ownerSchema = z.object({
  pid: pidSchema,
  host: z.string(),
  bootTime: z.number().optional(),
  startedAt: z.number().optional(),
  acquiredAt: z.number().optional(),
});

function bootTime() {
  try {
    return Date.now() - uptime() * 1000;
  } catch {
    // Some sandboxes do not expose host uptime.
    return undefined;
  }
}

function missing(error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return null;
  throw error;
}

async function unlinkIfCurrent(file: string, held: Stats) {
  const current = await lstat(file).catch(missing);
  if (
    current?.dev !== held.dev ||
    current.ino !== held.ino ||
    current.mtimeMs !== held.mtimeMs
  )
    return false;
  return (
    (await unlink(file)
      .then(() => true)
      .catch(missing)) === true
  );
}

function pidIsGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function staleReason(
  file: string,
  info: Stats,
  own: z.output<typeof ownerSchema>,
) {
  if (!info.isFile()) return null;
  const age = Date.now() - info.mtimeMs;
  if (age >= 12 * hour) return "older than 12 hours";
  const text =
    info.size <= 4096 ? await readFile(file, "utf8").catch(missing) : null;
  let value: unknown;
  try {
    value = JSON.parse(text ?? "null");
  } catch {
    value = null;
  }
  const owner = ownerSchema.safeParse(value).data;
  if (owner?.host === own.host) {
    if (
      own.bootTime !== undefined &&
      owner.bootTime !== undefined &&
      own.bootTime - owner.bootTime > 2000 &&
      own.bootTime > (owner.acquiredAt ?? info.mtimeMs) + 1000
    )
      return "owned by a process from a previous boot";
    if (
      owner.pid === own.pid &&
      owner.startedAt !== undefined &&
      startedAt - owner.startedAt > 2000
    )
      return `PID ${owner.pid} was reused`;
  }
  if (age < 3 * hour || (owner && owner.host !== own.host)) return null;
  const pid = owner?.pid ?? pidSchema.safeParse(value).data;
  return pid && !pidIsGone(pid) ? null : "stale owner is no longer running";
}

export async function withFlowLock<T>(
  deps: Pick<FlowDeps, "dir" | "flow">,
  work: () => Promise<T>,
  lockName = "feed.lock",
) {
  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  const file = path.join(deps.dir, lockName);
  const own = {
    pid: process.pid,
    host: hostname(),
    bootTime: bootTime(),
    startedAt,
    acquiredAt: Date.now(),
  };
  const claim = () => open(file, "wx", 0o600);
  const blocked = () =>
    new Error("Another feed command is running; retry after it finishes");
  const handle = await claim().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(file).catch(missing);
    if (info) {
      const reason = await staleReason(file, info, own);
      if (!reason) throw blocked();
      if (await unlinkIfCurrent(file, info))
        (deps.flow?.warn ?? console.error)(
          `Removed stale feed lock (${reason}).`,
        );
    }
    return claim().catch((retry: NodeJS.ErrnoException) => {
      if (retry.code === "EEXIST") throw blocked();
      throw retry;
    });
  });
  try {
    await handle.writeFile(JSON.stringify(own));
    return await work();
  } finally {
    try {
      await unlinkIfCurrent(file, await handle.stat());
    } finally {
      await handle.close();
    }
  }
}
