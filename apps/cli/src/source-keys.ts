import { z } from "zod";
import { UsageError } from "./command-types";
export type SourceKeyMode = "prompt" | "skip" | "env";
export interface SourceKeyDeps {
  readonly sourceKeyMode?: SourceKeyMode;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTTY?: boolean;
  prompt: (label: string, secret?: boolean) => Promise<string>;
}
const keys = ["S2_API_KEY", "OPENALEX_API_KEY", "CORE_API_KEY"] as const;
const modeSchema = z.enum(["prompt", "skip", "env"]);
const envSchema = z.object({
  S2_API_KEY: z.string().optional(),
  OPENALEX_API_KEY: z.string().optional(),
  CORE_API_KEY: z.string().optional(),
});
export function deploymentKeyMode(
  deps: SourceKeyDeps,
  selected?: SourceKeyMode,
): SourceKeyMode {
  const mode = modeSchema.parse(selected ?? deps.sourceKeyMode ?? "prompt");
  if (mode === "prompt" && !(deps.isTTY ?? Boolean(process.stdin.isTTY)))
    throw new UsageError(
      "Non-interactive deploy requires --skip-keys or --keys-from-env; keys can be configured later with litscout keys",
    );
  return mode;
}
export async function sourceKeys(
  deps: SourceKeyDeps,
): Promise<Record<string, string>> {
  const mode = modeSchema.parse(deps.sourceKeyMode ?? "prompt");
  if (mode === "skip") return {};
  if (mode === "env") {
    const env = deps.env ?? process.env;
    const input = envSchema.parse(
      Object.fromEntries(keys.map((key) => [key, env[key]])),
    );
    return Object.fromEntries(
      keys.flatMap((key) => {
        const value = input[key]?.trim();
        return value ? [[key, value]] : [];
      }),
    );
  }
  const entries = await keys.reduce(
    async (previous, key) => {
      const values = await previous;
      const value = (await deps.prompt(`${key} (blank to skip)`, true)).trim();
      return value ? [...values, [key, value] as const] : values;
    },
    Promise.resolve([] as (readonly [string, string])[]),
  );
  return Object.fromEntries(entries);
}
