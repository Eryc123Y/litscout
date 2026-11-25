import type { Stats } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";
import { UsageError, type CommandResult } from "./command-types";

const maxAge = 10 * 60_000;
const lockOwner = z.object({
  pid: z.number().int().positive().max(2_147_483_647),
  host: z.string().min(1),
  timestamp: z.iso.datetime(),
});

function missing(error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return null;
  throw error;
}

async function unlinkIfCurrent(file: string, expected: Stats) {
  const current = await lstat(file).catch(missing);
  if (
    !current ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.mtimeMs !== expected.mtimeMs
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

async function staleReason(file: string, info: Stats, host: string, now: Date) {
  if (!info.isFile()) return null;
  const owner =
    info.size <= 4096
      ? await readFile(file, "utf8")
          .then((text) => lockOwner.parse(JSON.parse(text)))
          .catch(() => null)
      : null;
  const timestamp = owner ? Date.parse(owner.timestamp) : info.mtimeMs;
  if (now.getTime() - timestamp > maxAge) return "older than 10 minutes";
  if (owner?.host === host && pidIsGone(owner.pid))
    return `PID ${owner.pid} is not running on ${host}`;
  return null;
}

export async function withSidecarLock(
  file: string,
  now: Date,
  work: () => Promise<CommandResult>,
) {
  const host = hostname();
  const blocked = () =>
    new UsageError(
      `Sidecar update locked at ${file}. Wait for the update to finish, or remove the lock file after confirming no update is running.`,
    );
  let recovery: string | undefined;
  const claim = () => open(file, "wx", 0o600);
  const handle = await claim().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(file).catch(missing);
    if (info) {
      const reason = await staleReason(file, info, host, now);
      if (!reason) throw blocked();
      if (await unlinkIfCurrent(file, info))
        recovery = `Removed stale sidecar lock ${file} (${reason}).`;
    }
    return claim().catch((retry: NodeJS.ErrnoException) => {
      if (retry.code === "EEXIST")
        throw new UsageError(
          [recovery, blocked().message].filter(Boolean).join("\n"),
        );
      throw retry;
    });
  });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, host, timestamp: now.toISOString() }),
    );
    const result = await work();
    if (!recovery) return result;
    const data = result.data as Record<string, unknown>;
    return {
      ...result,
      data: {
        ...data,
        messages: [
          recovery,
          ...(Array.isArray(data.messages)
            ? data.messages
            : [JSON.stringify(data, null, 2)]),
        ],
      },
    };
  } catch (error) {
    if (!recovery) throw error;
    const message =
      error instanceof UsageError
        ? error.message
        : "Command failed; check authentication and local configuration";
    throw new UsageError(`${recovery}\n${message}`, { cause: error });
  } finally {
    try {
      await unlinkIfCurrent(file, await handle.stat());
    } finally {
      await handle.close();
    }
  }
}
