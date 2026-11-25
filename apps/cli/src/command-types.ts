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
  /** --json was given: print JSON and ask no questions. */
  json?: boolean;
  /** The home folder a trial's data goes under (~ unless a test sets it). */
  home?: string;
  /** The time zone `init` suggests; this computer's unless a test sets it. */
  timeZone?: () => string;
}
export class UsageError extends Error {}
export interface CommandResult {
  readonly data: unknown;
  readonly configPath?: string;
  readonly empty?: boolean;
  readonly failed?: boolean;
}
