import { pruneCommand, pruneOptions } from "./prune-command";
import { serverCommand, serverOptions } from "./server-command";
import { sidecarCommand, sidecarOptions } from "./sidecar-command";
import { endpointConfig } from "./endpoint";
import { access, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { managementOptions, runCli } from "./commands";
import { ConfigError } from "./config-loader";
import { output } from "./output";
import {
  UsageError,
  type SetupDeps,
  type CommandResult,
} from "./command-types";
import {
  deployCommand,
  deploymentOptions,
  deployedWorkerName,
} from "./deploy-command";
import { doctorCommand } from "./doctor-command";
import { configOptions, commandConfig } from "./config-options";
import { backupCommand, backupOptions } from "./backup-command";
import { tokenCommand, tokenOptions } from "./token-commands";
import { feedCommand, feedCommands, feedOptions } from "./feed-command";
import { libraryCommand, libraryOptions } from "./library-command";
import { vaultCommand, vaultOptions } from "./vault-command";
import { shadowReportCommand, shadowReportOptions } from "./shadow-command";
import { flowApi } from "./flow-runtime";
import { alphaXivCommand, alphaXivOptions } from "./alphaxiv-command";
import { parseArgs as watchOptions } from "@litscout/sources/watch/args";
import { dayReopenOptions } from "./day-options";
import { dayCommand } from "./day-command";
import { trendsCommand, trendsOptions } from "./trends-command";
import { serverBudgetSchema } from "@litscout/pipeline/budget";
import { ApiFailure } from "@litscout/pipeline/api-failure";
import { operationalReason } from "./operational-errors";
import type { BudgetReconciliation } from "./budget-reconcile";
import { cutoverCheck, cutoverOptions } from "./cutover-command";
export type { SetupDeps } from "./command-types";
function noOptions(
  command: string,
  args: readonly string[],
  explicit?: string,
) {
  if (args.length || explicit) throw new UsageError(`Use ${command} [--json]`);
}
const documentedCommands = {
  init: (args: readonly string[], explicit?: string) =>
    noOptions("init", args, explicit),
  deploy: deploymentOptions,
  token: tokenOptions,
  pair: (args: readonly string[], explicit?: string) =>
    noOptions("pair", args, explicit),
  doctor: (args: readonly string[]) => {
    if (!args.length) return { live: false };
    if (args.length === 1 && args[0] === "--live") return { live: true };
    throw new UsageError("Use doctor [--live] [--config PATH] [--json]");
  },
};
function commandLine(input: readonly string[]) {
  const parsed = configOptions(input.filter((arg) => arg !== "--json"));
  const { args } = parsed;
  // Move preview flags before the command or action to its option list.
  // Leave the other positions intact so a missing option value is rejected.
  if (args[0] === "--dry-run" && (args[1] === "deploy" || args[1] === "token"))
    args.push(...args.splice(0, 1));
  if (args[0] === "token" && args[1] === "--dry-run")
    args.push(...args.splice(1, 1));
  return parsed;
}

/** Validate CLI examples without loading config or executing commands. */
export function parseCommand(input: readonly string[]) {
  const {
    args: [command, ...rest],
    explicit,
  } = commandLine(input);
  const args = command ? [command, ...rest] : [];
  if (feedCommands.includes(command ?? "")) return feedOptions(args, explicit);
  switch (command) {
    case "init":
    case "deploy":
    case "token":
    case "pair":
    case "doctor":
      return documentedCommands[command](rest, explicit);
    case "sidecar":
      return sidecarOptions(rest, explicit);
    case "cutover":
      return cutoverOptions(rest);
    case "shadow":
      return shadowReportOptions(rest);
    case "vault":
      return vaultOptions(rest);
    case "sync":
    case "ideas":
    case "wp":
    case "suggestions":
      return vaultOptions(args);
    case "library":
    case "save":
    case "search":
    case "links":
      return libraryOptions(args);
    case "alphaxiv":
      return alphaXivOptions(rest);
    case "trends":
      return trendsOptions(rest);
    case "day":
      return dayReopenOptions(rest);
    case "prune":
      return pruneOptions(rest);
    case "server":
      return serverOptions(rest);
    case "backup":
      return backupOptions(rest);
  }
  if (explicit) throw new UsageError("This command does not use --config");
  const help = rest.includes("--help") || rest.includes("-h");
  if (command === "watch") return help ? undefined : watchOptions(rest);
  if (command === "abstracts")
    return help ? undefined : noOptions(command, rest);
  return managementOptions(args);
}
async function init(deps: SetupDeps): Promise<CommandResult> {
  const names = [
    "litscout.config.ts",
    "venues.json",
    "vault-paper-template.md",
    "vault-digest-template.md",
    "antigravity-sidecar.json",
    "claude-scheduled-task.md",
    "codex-exec.md",
    "cron.md",
  ];
  for (const name of names)
    if (
      await access(path.join(deps.cwd, name)).then(
        () => true,
        () => false,
      )
    )
      throw new UsageError(`Refusing to overwrite ${name}`);
  const created: string[] = [];
  try {
    for (const name of names) {
      const target = path.join(deps.cwd, name);
      await writeFile(
        target,
        await readFile(path.join(deps.templateDir, name)),
        { flag: "wx" },
      );
      created.push(target);
    }
  } catch (error) {
    await Promise.all(created.map((file) => unlink(file)));
    throw error;
  }
  return {
    data: {
      created: names,
      messages: [
        `Created: ${names.join(", ")}`,
        "Edit litscout.config.ts for categories, topics, language, agent mode and optional vault paths.",
        "Edit venues.json for venues and replace the placeholders in your chosen scheduler example.",
        "Follow docs/self-host.md for deployment and the first run.",
      ],
    },
  };
}
async function configuredCommand(
  args: readonly string[],
  deps: SetupDeps,
  explicit: string | undefined,
  onResolved: (file: string) => void,
): Promise<CommandResult> {
  const [command, ...rest] = args;
  const readiness = command === "cutover" ? cutoverOptions(rest) : null;
  const loaded = await commandConfig(deps, explicit);
  onResolved(loaded.file);
  const config = loaded.config;
  if (command === "deploy")
    return deployCommand(deps, config, documentedCommands.deploy(rest));
  const name = await deployedWorkerName(deps, config);
  if (command === "token")
    return tokenCommand(
      deps,
      `${name}-db`,
      (await endpointConfig(config, deps.dir)).config.instance.publicUrl,
      documentedCommands.token(rest),
    );
  if (readiness)
    return cutoverCheck(
      readiness,
      { ...deps, configDir: path.dirname(loaded.file) },
      config,
      name,
      loaded.file,
    );
  return doctorCommand(
    deps,
    config,
    name,
    loaded.file,
    documentedCommands.doctor(rest),
  );
}
async function dispatch(
  args: readonly string[],
  deps: SetupDeps,
  explicit: string | undefined,
  onResolved: (file: string) => void,
): Promise<CommandResult> {
  const [command, ...rest] = args;
  if (command === "sidecar") return sidecarCommand(rest, deps, explicit);
  if (command === "backup")
    return backupCommand(rest, deps, async () => {
      const loaded = await commandConfig(deps, explicit);
      onResolved(loaded.file);
      return loaded.config;
    });
  if (command === "prune") {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return pruneCommand(rest, deps, loaded.config);
  }
  if (command === "server") {
    serverOptions(rest);
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return serverCommand(rest, deps, loaded.config);
  }
  if (command === "trends") {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return trendsCommand(rest, deps, loaded.config);
  }
  if (command === "day") {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return dayCommand(rest, deps, loaded.config);
  }
  if (command === "shadow") {
    const options = shadowReportOptions(rest);
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    const config = (await endpointConfig(loaded.config, deps.dir)).config;
    return shadowReportCommand(
      options,
      await flowApi(deps, config),
      deps,
      config,
    );
  }
  if (
    command &&
    ["vault", "sync", "ideas", "wp", "suggestions"].includes(command)
  ) {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return vaultCommand(
      command === "vault" ? rest : args,
      { ...deps, configDir: path.dirname(loaded.file) },
      loaded.config,
    );
  }
  if (command === "alphaxiv") {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return alphaXivCommand(
      rest,
      deps,
      loaded.config,
      path.dirname(loaded.file),
    );
  }
  if (["library", "save", "search", "links"].includes(command ?? "")) {
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return libraryCommand(args, deps, loaded.config);
  }
  if (feedCommands.includes(command ?? "")) {
    if (
      command === "contracts" ||
      ((command === "migrate" || command === "legacy") &&
        args.includes("--dry-run") &&
        args.includes("--repo"))
    )
      return feedCommand(args, deps, undefined, explicit);
    const loaded = await commandConfig(deps, explicit);
    onResolved(loaded.file);
    return feedCommand(
      args,
      { ...deps, configDir: path.dirname(loaded.file) },
      loaded.config,
    );
  }
  if (command === "init") {
    documentedCommands.init(rest, explicit);
    const result = await init(deps);
    onResolved(path.resolve(deps.cwd, "litscout.config.ts"));
    return result;
  }
  if (["deploy", "doctor", "token", "cutover"].includes(command ?? ""))
    return configuredCommand(args, deps, explicit, onResolved);
  if (command === "pair") documentedCommands.pair(rest, explicit);
  if (explicit)
    throw new UsageError(
      "--config is supported by deploy, doctor and token commands",
    );
  const messages: string[] = [];
  await runCli(args, { ...deps, print: (text) => messages.push(text) });
  if (!command || ["help", "--help", "-h"].includes(command))
    messages.push(
      "Library: save <doi|url|arxiv|title> [--dry-run], search <query>, library import <file> [--format bibtex|csl] [--dry-run], links check [--limit N], alphaxiv import <file> [--dry-run].",
      "Vault: sync [--dry-run] [--only index|requests|blocks|digests] [--adopt], ideas list|show|capture, wp list|show, suggestions list|accept|dismiss.",
      "Daily run reports: daily start [--day DAY], daily report FILE. Export: backup [--out FILE], backup --verify FILE, backup restore FILE [--dry-run] [--max-rows N | --keep-rows N]. Retention: prune [--dry-run] [--over-cap]. Own server: server init [--base DIR] [--local] [--force] [--dry-run], server report FILE.",
      "Cutover: cutover check [--reports-dir DIR] [--backup FILE] [--accept-overlap], shadow report (--old-digest FILE | --old-digests DIR) [--old-completed-at ISO] [--new-day DAY] [--client NAME], sidecar cutover|rollback, vault enable-writes --digests-dir PATH [--dry-run] [--adopt].",
      "Trends: trends [--topic T] [--month YYYY-MM], trends refresh [--month YYYY-MM], trends backfill.",
      "Daily recovery: day reopen <day> [--dry-run] [--yes].",
      "Setup: init, doctor [--live], sidecar shadow|restore|old-prompt, token create [--dry-run], token list|revoke; deploy [--name NAME] [--dry-run] [--allow-over-budget] [--skip-keys | --keys-from-env]. All commands accept --json.",
    );
  return {
    data: { messages },
    empty: messages.length === 1 && messages[0] === "Cancelled.",
  };
}
/**
 * An error this code did not write may hold upstream text, so only its
 * status or error code is shown, when it has one.
 */
function unexpectedFailure(error: unknown) {
  const reason = operationalReason(error);
  return (
    "Command failed" +
    (reason === "error code unavailable" ? "" : ` (${reason})`) +
    "; check authentication and local configuration"
  );
}
export async function runCommand(
  args: readonly string[],
  deps: SetupDeps,
): Promise<number> {
  const json = args.includes("--json");
  let configPath: string | null = null;
  let command: string | undefined;
  try {
    const parsed = commandLine(args);
    [command] = parsed.args;
    const result = await dispatch(
      parsed.args,
      deps,
      parsed.explicit,
      (file) => {
        configPath = file;
      },
    );
    if (parsed.args[0] === "sidecar" && parsed.args[1] === "old-prompt") {
      deps.print(String(result.data));
      return 0;
    }
    if (parsed.args[0] === "doctor" && !json)
      deps.print(`Config: ${configPath}`);
    const budget =
      command === "budget" && !json
        ? serverBudgetSchema.loose().safeParse(result.data).data
        : undefined;
    const reconciliation = budget?.reconciliation as
      BudgetReconciliation | undefined;
    output(
      deps.print,
      json,
      budget
        ? {
            messages: [
              `UTC day: ${budget.day}`,
              `Used: ${budget.used} of ${budget.limit} writes`,
              `Safety margin: ${(budget.baseLimit ?? budget.limit) - budget.limit} writes`,
              `Unaccounted: ${budget.unaccounted ?? 0} writes`,
              `Above estimates: ${budget.estimateOverrun ?? 0} writes`,
              `Migration: ${budget.migration ?? 0} writes`,
              `Reserved: ${budget.reserved} writes`,
              `Stale reservations released: ${budget.staleLeasesReleased}`,
              `UTC reset: ${budget.resetAt}`,
              ...(reconciliation?.reportedRows === undefined
                ? []
                : [
                    `D1 reported ${reconciliation.reportedRows} writes for the UTC day`,
                  ]),
              ...(reconciliation?.warnings ?? []),
            ],
          }
        : result.data,
      !result.failed,
      { configPath },
    );
    return result.failed ? 1 : result.empty ? 2 : 0;
  } catch (error) {
    const message =
      error instanceof UsageError || error instanceof ConfigError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("\n")
          : error instanceof ApiFailure
            ? error.message
            : unexpectedFailure(error);
    const data =
      command === "doctor" && error instanceof ConfigError
        ? {
            configValid: false,
            message,
            hint: "Fix the reported config fields or run litscout init. Use --config PATH to select a specific file.",
          }
        : command === "cutover" && error instanceof ConfigError
          ? {
              decision: "no-go",
              reasons: [message],
              messages: ["NO-GO", message],
            }
          : { message };
    output(deps.print, json, data, false, {
      configPath:
        error instanceof ConfigError
          ? (error.configPath ?? configPath)
          : configPath,
    });
    return 1;
  }
}
