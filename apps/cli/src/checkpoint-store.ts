import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { secureDir, privateJson } from "./state";
export async function writeCheckpoint(
  file: string,
  value: unknown,
  maxBytes = 64 * 1024 * 1024,
) {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string" || Buffer.byteLength(text + "\n") > maxBytes)
    throw new Error("Invalid or oversized resume checkpoint");
  await privateJson(file, value);
}
export function resumePath(dir: string, endpoint: string) {
  const key = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
  return path.join(dir, "resume", key);
}
export async function resumeDirectory(dir: string, endpoint: string) {
  const target = resumePath(dir, endpoint);
  await secureDir(target);
  return target;
}
export async function readCheckpoint<T>(
  file: string,
  schema: z.ZodType<T>,
  maxBytes = 64 * 1024 * 1024,
): Promise<T | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Invalid or oversized resume checkpoint");
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
