import {
  sourceKeys,
  deploymentKeyMode,
  type SourceKeyDeps,
} from "./source-keys";
import type { VenueTable } from "@litscout/sources/sources/venue";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import template from "./worker-template.json" with { type: "json" };
import { privateJson, readState, secureDir, type LocalState } from "./state";
import { operationalReason } from "./operational-errors";
import { wranglerLine } from "./runtime";
import { z } from "zod";
import { UsageError } from "./command-types";
import {
  applyMigrations,
  checkMigrationBudget,
  migrationMessages,
  migrationPlan,
} from "./migration-deploy";
export interface CliDeps extends SourceKeyDeps {
  workerName?: string;
  workerVars?: Readonly<Record<string, string>>;
  publicUrl?: string;
  workerConfig?: Record<string, unknown>;
  fetchVenues: () => Promise<VenueTable>;
  dir: string;
  bundlePath: string;
  run: (args: readonly string[]) => Promise<string>;
  prompt: (label: string, secret?: boolean) => Promise<string>;
  fetch: typeof fetch;
  print: (text: string) => void;
}
const commands = [
  "deploy",
  "pair",
  "clients",
  "revoke",
  "status",
  "keys",
  "destroy",
];
function configPath(deps: CliDeps): string {
  return path.join(deps.dir, "wrangler.jsonc");
}
async function writeConfig(deps: CliDeps, state: LocalState): Promise<void> {
  await privateJson(configPath(deps), {
    ...template,
    ...deps.workerConfig,
    name: state.name,
    main: deps.bundlePath,
    vars: {
      ...deps.workerVars,
      PUBLIC_URL:
        deps.publicUrl ?? state.endpoint ?? "https://not-configured.invalid",
    },
    kv_namespaces: [{ binding: "OAUTH_KV", id: state.namespaceId }],
  });
}
async function upload(
  deps: CliDeps,
  secrets: Record<string, string>,
  put = (file: string) =>
    deps.run(["secret", "bulk", file, "--config", configPath(deps)]),
): Promise<void> {
  if (!Object.keys(secrets).length) return;
  const directory = await mkdtemp(path.join(deps.dir, "secrets-"));
  const file = path.join(directory, "secrets.json");
  try {
    await privateJson(file, secrets);
    await put(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function deploymentState(deps: CliDeps): Promise<LocalState> {
  const previous = await readState(deps.dir).catch(() => undefined);
  if (previous && (!deps.workerName || deps.workerName === previous.name))
    return previous;
  if (previous)
    await privateJson(
      path.join(deps.dir, `state.${previous.name}.json`),
      previous,
    );
  const name =
    deps.workerName ??
    ((await deps.prompt("Worker name (litscout)")).trim() || "litscout");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name))
    throw new Error("Invalid Worker name");
  const state = {
    name,
    token: crypto.randomUUID() + crypto.randomUUID(),
    consentSecret: crypto.randomUUID() + crypto.randomUUID(),
  };
  await privateJson(path.join(deps.dir, "state.json"), state);
  return state;
}
const databases = z.array(
  z.object({ name: z.string(), uuid: z.string().regex(/^[a-zA-Z0-9-]+$/) }),
);
type DatabaseBindings = (uuid: string) => Record<string, unknown>;
const findDatabase = (raw: string, name: string) =>
  databases.parse(JSON.parse(raw)).find((row) => row.name === name)?.uuid;

function deploymentSteps(
  deps: CliDeps,
  bindDatabase?: DatabaseBindings,
  allowOverBudget = false,
) {
  const config = configPath(deps);
  const name = deps.workerName ?? "WORKER_NAME";
  const database = name + "-db";
  let uuid: string | undefined;
  let needsLogin = false;
  let state: LocalState;
  let endpoint: string;
  let workerConfig = deps.workerConfig;
  let migrations: Awaited<ReturnType<typeof migrationPlan>>;
  // Preview and execution traverse this same list. Only execution resolves
  // deployment state and substitutes generated values in Wrangler arguments.
  const steps: { line?: string; execute?: () => Promise<void> }[] = [];
  const wrangler = (
    args: string[],
    execute: (
      run: (substitute?: Record<string, string>) => Promise<string>,
    ) => Promise<void>,
    note?: string,
  ) => {
    steps.push({
      line: wranglerLine(args) + (note ? " # " + note : ""),
      execute: () =>
        execute((substitute) =>
          deps.run(
            substitute
              ? args.map((arg) =>
                  Object.hasOwn(substitute, arg) ? substitute[arg]! : arg,
                )
              : args,
          ),
        ),
    });
  };
  if (bindDatabase) {
    wrangler(["whoami"], async (run) => {
      const identity = await run().catch(() => "");
      if (!identity.trim() || /not (?:logged|authenticated)/i.test(identity))
        throw new UsageError("Run pnpm exec wrangler login before deploying.");
    });
    wrangler(["d1", "list", "--json"], async (run) => {
      uuid = findDatabase(await run(), database);
      migrations = await migrationPlan(deps, uuid);
      checkMigrationBudget(migrations, allowOverBudget);
      migrationMessages(migrations, allowOverBudget).forEach(deps.print);
    });
    wrangler(
      ["d1", "create", database, "--no-update-config"],
      async (run) => {
        if (!uuid) await run();
      },
      "only if missing",
    );
    wrangler(
      ["d1", "list", "--json"],
      async (run) => {
        const id = uuid ?? findDatabase(await run(), database);
        if (!id)
          throw new UsageError(
            "Wrangler did not return the new database; retry deploy",
          );
        workerConfig = bindDatabase(id);
      },
      "after creation",
    );
  }
  wrangler(
    ["whoami"],
    async (run) => {
      await secureDir(deps.dir);
      try {
        needsLogin = /not (?:logged|authenticated)/i.test(await run());
      } catch {
        needsLogin = true;
      }
    },
    bindDatabase ? "recheck before MCP provisioning" : undefined,
  );
  const retry = "if the recheck fails";
  wrangler(
    ["login"],
    async (run) => {
      if (needsLogin) await run();
    },
    retry,
  );
  wrangler(
    ["whoami"],
    async (run) => {
      if (needsLogin) await run();
    },
    retry,
  );
  const namespace = name + "-oauth";
  wrangler(
    ["kv", "namespace", "create", namespace, "--no-update-config"],
    async (run) => {
      state = await deploymentState(deps);
      if (state.namespaceId) return;
      const result = await run({ [namespace]: state.name + "-oauth" });
      const namespaceId = result.match(/"id"\s*:\s*"([\w-]+)"/)?.[1];
      if (!namespaceId)
        throw new Error("Wrangler did not return a KV namespace id");
      state = { ...state, namespaceId };
      await privateJson(path.join(deps.dir, "state.json"), state);
    },
    "if no OAuth namespace is recorded for this Worker",
  );
  steps.push({ execute: () => writeConfig({ ...deps, workerConfig }, state) });
  if (bindDatabase)
    steps.push({
      line: "# Apply the listed D1 migrations with Wrangler and charge the daily write budget.",
      execute: () =>
        applyMigrations(deps, database, migrations, allowOverBudget, config),
    });
  const venuesFile = path.join(deps.dir, "venues.json");
  const namespacePlaceholder = "KV_NAMESPACE_ID";
  wrangler(
    [
      "kv",
      "key",
      "put",
      "litscout:venues",
      "--path",
      venuesFile,
      "--namespace-id",
      namespacePlaceholder,
      "--remote",
    ],
    async (run) => {
      let venueStep = "download";
      try {
        const table = await deps.fetchVenues();
        venueStep = "local file";
        await privateJson(venuesFile, table);
        venueStep = "KV put";
        await run({ [namespacePlaceholder]: state.namespaceId! });
      } catch (error) {
        deps.print(
          `Venue tables ${venueStep} failed (${operationalReason(error)}). Search remains available; rerun deploy to retry.`,
        );
      }
    },
    "after fetching and saving CCF and ICORE tables",
  );
  const secretFile = "PRIVATE_TEMP_FILE";
  wrangler(
    ["secret", "bulk", secretFile, "--config", config],
    async (run) => {
      // Keep source keys only in the short-lived private upload file.
      await upload(
        deps,
        {
          ...(await sourceKeys(deps)),
          MGMT_TOKEN: state.token,
          ...(state.consentSecret
            ? { CONSENT_SECRET: state.consentSecret }
            : {}),
        },
        (file) => run({ [secretFile]: file }),
      );
    },
    "creates a draft Worker if absent",
  );
  const mode = deps.sourceKeyMode;
  const keys =
    mode === "skip"
      ? "no source keys"
      : mode === "env"
        ? "nonempty source keys from the environment"
        : "source keys entered privately";
  steps.push({
    line: `# Upload MGMT_TOKEN, CONSENT_SECRET on first setup, and ${keys}. Remove the temporary file afterward.`,
  });
  const deployArgs = ["deploy", "--config", config];
  wrangler(deployArgs, async (run) => {
    const output = await run();
    const resolved =
      [...output.matchAll(/(?:^|\n)\s*(https:\/\/[^\s"'<>]+)\s*(?=\n|$)/g)]
        .at(-1)?.[1]
        ?.replace(/\/$/, "") ?? state.endpoint;
    if (!resolved)
      throw new Error(
        "Deployment URL missing; local state preserved for retry.",
      );
    endpoint = resolved;
    state = { ...state, endpoint: deps.publicUrl ?? endpoint };
    await writeConfig({ ...deps, workerConfig }, state);
  });
  wrangler(
    deployArgs,
    async (run) => {
      await run();
      await privateJson(path.join(deps.dir, "state.json"), {
        ...state,
        consentSecret: undefined,
      });
      deps.print(`Deployed: ${endpoint}/mcp\nNext: litscout pair`);
    },
    "bind the configured or returned public origin for MCP",
  );
  return steps;
}

export async function deployWorker(
  deps: CliDeps,
  bindDatabase?: DatabaseBindings,
  dryRun = false,
  allowOverBudget = false,
) {
  const steps = deploymentSteps(deps, bindDatabase, allowOverBudget);
  if (dryRun) {
    const database = deps.workerName + "-db";
    const uuid = findDatabase(
      await deps.run(["d1", "list", "--json"]).catch(() => {
        throw new UsageError(
          "Wrangler could not list D1 databases. Check your Cloudflare authentication before previewing deploy.",
        );
      }),
      database,
    );
    const plan = await migrationPlan(deps, uuid);
    return {
      commands: [
        ...migrationMessages(plan, allowOverBudget),
        ...steps.flatMap(({ line }) => (line ? [line] : [])),
      ],
      migrations: plan.migrations,
      remaining: plan.remaining,
      resetAt: plan.resetAt,
    };
  }
  deploymentKeyMode(deps);
  for (const { execute } of steps) {
    if (execute) await execute();
  }
}
async function admin(
  deps: CliDeps,
  state: LocalState,
  command: string,
  id?: string,
): Promise<void> {
  if (!state.endpoint)
    throw new Error("Deployment incomplete; run litscout deploy again.");
  const response = await deps.fetch(`${state.endpoint}/admin/${command}`, {
    method: ["pair", "revoke"].includes(command) ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body: id ? JSON.stringify({ id }) : undefined,
  });
  if (!response.ok)
    throw new Error(`Management request failed (HTTP ${response.status})`);
  const data = (await response.json()) as { code?: string };
  deps.print(
    command === "pair"
      ? `Connector: ${state.endpoint}/mcp\nPairing code: ${data.code}\nExpires in 10 minutes.`
      : JSON.stringify(data, null, 2),
  );
}
export function managementOptions(args: readonly string[]) {
  const [command, id, ...extra] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    if (id !== undefined) throw new Error("Use help without arguments");
    return { command: "help" };
  }
  if (!commands.includes(command))
    throw new Error("Unknown command; use --help");
  if (extra.length || (id && command !== "revoke") || id?.startsWith("-"))
    throw new Error("Unexpected arguments; enter keys at the private prompt");
  if (command === "revoke" && !id)
    throw new Error("Client id required: litscout revoke <id>");
  return { command, id };
}
export async function runCli(
  args: readonly string[],
  deps: CliDeps,
): Promise<void> {
  const { command, id } = managementOptions(args);
  if (command === "help") {
    deps.print(
      `LitScout: ${commands.join(", ")}, watch, abstracts\nKeys are entered privately, never as arguments.\nwatch --since YYYY-MM-DD --venues <file>: journal and conference papers as JSON Lines (see README).\nabstracts < items.jsonl: fill missing abstracts by DOI, arXiv ID or title, JSON Lines in and out (see README).`,
    );
    return;
  }
  if (command === "deploy") {
    await deployWorker(deps);
    return;
  }
  const state = await readState(deps.dir);
  if (command === "keys") {
    await upload(deps, await sourceKeys(deps));
    deps.print("Source keys updated.");
    return;
  }
  if (command === "destroy") {
    if (
      (await deps.prompt("Delete this Worker and its OAuth KV? Type yes")) !==
      "yes"
    ) {
      deps.print("Cancelled.");
      return;
    }
    await deps.run(["delete", "--config", configPath(deps), "--force"]);
    if (state.namespaceId)
      await deps.run([
        "kv",
        "namespace",
        "delete",
        "--namespace-id",
        state.namespaceId,
      ]);
    await rm(path.join(deps.dir, "state.json"));
    await rm(configPath(deps), { force: true });
    deps.print("Deployment removed.");
    return;
  }
  await admin(deps, state, command, id);
}
