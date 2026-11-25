import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { validateConfig, type LitScoutConfig } from "@litscout/core";
export interface LoadedConfig {
  readonly file: string;
  readonly config: LitScoutConfig;
}
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly configPath?: string,
  ) {
    super(message);
  }
}
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
/**
 * Where a config's `import { defineConfig } from "@litscout/core"` points. A
 * built CLI copied to a server has no packages beside it; it ships
 * config-core.mjs with defineConfig instead (validation happens here).
 */
export function coreModule(
  resolve: (specifier: string) => string = import.meta.resolve,
  base = import.meta.url,
) {
  try {
    return fileURLToPath(resolve("@litscout/core"));
  } catch {
    return fileURLToPath(new URL("./config-core.mjs", base));
  }
}
async function readConfig(candidate: string): Promise<LoadedConfig> {
  const file = await realpath(candidate).catch(() => path.resolve(candidate));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    alias: { "@litscout/core": coreModule() },
  });
  let input: unknown;
  try {
    input = await jiti.import(file, { default: true });
  } catch (error) {
    if (error instanceof Error && error.name === "ConfigValidationError")
      throw new ConfigError(error.message, file);
    throw new ConfigError(`Unable to load ${file}`, file);
  }
  try {
    return { file, config: validateConfig(input) };
  } catch (error) {
    throw new ConfigError(String(error), file);
  }
}
export async function loadConfig(
  cwd: string,
  explicit?: string,
  home = homedir(),
): Promise<LoadedConfig> {
  if (explicit) return readConfig(path.resolve(cwd, explicit));
  let directory = await realpath(cwd);
  const boundary = await realpath(home).catch(() => path.resolve(home));
  while (true) {
    const file = path.join(directory, "litscout.config.ts");
    if (await exists(file)) return readConfig(file);
    const parent = path.dirname(directory);
    if (
      directory === boundary ||
      (await exists(path.join(directory, ".git"))) ||
      parent === directory
    )
      throw new ConfigError(
        "No litscout.config.ts found within the Git/home boundary; run litscout init or use --config PATH",
      );
    directory = parent;
  }
}
