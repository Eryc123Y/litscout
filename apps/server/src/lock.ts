import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

function running(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One process at a time may open a state folder. A lock left by a process
 * that has gone is replaced. Returns the function that releases it; the lock
 * is also released when this process exits, since Miniflare ends the process
 * itself on SIGTERM.
 */
export function lockState(state: string, pid = process.pid) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = path.join(state, ".lock");
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch {
    const holder = Number(readFileSync(file, "utf8"));
    if (holder !== pid && running(holder))
      throw new Error(
        `Another litscout-server (pid ${holder}) is using ${state}. Stop it first.`,
      );
    rmSync(file, { force: true });
    fd = openSync(file, "wx", 0o600);
  }
  writeSync(fd, String(pid));
  closeSync(fd);
  const release = () => {
    process.off("exit", release);
    rmSync(file, { force: true });
  };
  process.on("exit", release);
  return release;
}
