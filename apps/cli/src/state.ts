import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
export interface LocalState {
  token: string;
  consentSecret?: string;
  name: string;
  namespaceId?: string;
  endpoint?: string;
}
export async function secureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
export async function privateJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, file);
}
const stateSchema = z.object({
  token: z.string().min(1),
  consentSecret: z.string().optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  namespaceId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  endpoint: z.url().optional(),
});
export async function readState(dir: string): Promise<LocalState> {
  try {
    return stateSchema.parse(
      JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")),
    );
  } catch {
    throw new Error("No deployment state. Run litscout deploy first.");
  }
}
