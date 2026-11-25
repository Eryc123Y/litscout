import type { LitScoutConfig } from "@litscout/core";
import type { CliDeps } from "./commands";
export interface SetupDeps extends CliDeps {
  cacheDir?: string;
  configDir?: string;
  flow?: import("./flow-runtime").FlowOverrides;
  cwd: string;
  templateDir: string;
  nodeVersion?: string;
  loadConfig?: () => Promise<LitScoutConfig>;
}
export class UsageError extends Error {}
export interface CommandResult {
  readonly data: unknown;
  readonly configPath?: string;
  readonly empty?: boolean;
  readonly failed?: boolean;
}
