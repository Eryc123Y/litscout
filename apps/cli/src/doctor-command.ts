import { databaseLimitBytes, retentionReport } from "./prune-command";
import path from "node:path";
import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { apiOrigin, httpsBrowserOrigin } from "@litscout/core/config";
import { SCHEMA_VERSION, scopesSchema } from "@litscout/db";
import { openVault } from "@litscout/sync/vault-source";
import { inspectTokens } from "./token-warnings";
import { profileWarnings } from "./config-warnings";
import type { SetupDeps, CommandResult } from "./command-types";
import { agentPreflight, credential } from "./flow-runtime";
import { serverBudgetSchema } from "@litscout/pipeline/budget";
import { endpointConfig } from "./endpoint";
import { databaseUsage, reconcileBudget } from "./budget-reconcile";
import { apiHost, liveApiCheck } from "./agent-api";
import { legacyStatus } from "./legacy-command";
import { notUsed, serverChecks, workerRuntime } from "./doctor-server";

const healthSchema = z.object({
  database: z.object({
    reachable: z.boolean(),
    schemaVersion: z.number().nullable(),
  }),
  bindings: z.object({ DB: z.boolean(), OAUTH_KV: z.boolean() }).optional(),
  token: z
    .object({ scopes: scopesSchema, legacyVault: z.boolean() })
    .optional(),
});

const check = (ok: boolean, hint: string) => (ok ? { ok } : { ok, hint });

async function wranglerChecks(deps: SetupDeps) {
  const output = await deps.run(["--version"]).catch(() => "");
  const version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  const identity = version ? await deps.run(["whoami"]).catch(() => "") : "";
  const loggedIn =
    !!identity.trim() &&
    !/not (?:logged|authenticated)|not currently logged/i.test(identity);
  return {
    wrangler: {
      ...check(
        !!version,
        "Build the CLI and install dependencies with pnpm install.",
      ),
      version,
    },
    wranglerLogin: check(
      loggedIn,
      "Run pnpm exec wrangler login in the repository.",
    ),
  };
}

async function probe<T>(
  deps: SetupDeps,
  base: string,
  route: string,
  schema: z.ZodType<T>,
  token?: string,
) {
  try {
    const response = await deps.fetch(new URL(route, base), {
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = schema.safeParse(await response.json());
    return {
      status: response.status,
      data: parsed.success ? parsed.data : null,
    };
  } catch {
    return null;
  }
}

async function workerChecks(
  deps: SetupDeps,
  endpoint: string | undefined,
  readOnly: boolean,
  beforeBudget: Promise<unknown>,
  requiresVault: Promise<boolean>,
) {
  const base = apiOrigin(endpoint);
  const token = base
    ? await credential(deps, base).catch(() => undefined)
    : undefined;
  const [publicHealth, health, budgetResponse, vaultRequired] =
    await Promise.all([
      base && probe(deps, base, "/health", z.object({ ok: z.boolean() })),
      base &&
        token &&
        probe(
          deps,
          base,
          readOnly ? "/api/v1/vault/health" : "/api/v1/health",
          z.object({ data: healthSchema }),
          token,
        ),
      base &&
        token &&
        beforeBudget.then(() =>
          probe(
            deps,
            base,
            readOnly ? "/api/v1/vault/budget" : "/api/v1/budget",
            z.object({
              success: z.literal(true),
              data: serverBudgetSchema,
            }),
            token,
          ),
        ),
      requiresVault,
    ]);
  const details = health ? health.data?.data : undefined;
  const budget =
    budgetResponse && budgetResponse.status === 200
      ? (budgetResponse.data?.data ?? null)
      : null;
  const readScope =
    !!details && Boolean(health && [200, 503].includes(health.status));
  // The read-only cutover budget endpoint itself requires vault scope.
  const ingestScope = readOnly
    ? details?.token?.scopes.includes("ingest") === true
    : !!budget;
  const legacyVault = details?.token?.legacyVault === true;
  const vaultScope =
    details?.token?.scopes.includes("vault") === true || legacyVault;
  const retryToken =
    !token ||
    [health, budgetResponse].some(
      (response) =>
        response && (response.status === 401 || response.status === 403),
    ) ||
    (readScope &&
      ((!ingestScope && readOnly) || (vaultRequired && !vaultScope)));
  const schedulerScopes = vaultRequired ? "read,ingest,vault" : "read,ingest";
  const tokenHint = `Run litscout token create --name scheduler --scopes ${schedulerScopes} for this deployment.`;
  const workerHint =
    "Run litscout deploy and use its HTTPS workers.dev origin for instance.publicUrl.";
  const bindingsHint = readScope
    ? "Run litscout deploy to restore the Worker bindings."
    : "Resolve the Worker and read token checks, then rerun doctor to inspect deployed bindings.";
  const schemaVersion = details?.database.schemaVersion ?? null;
  return {
    budget,
    warnings: legacyVault
      ? [
          `Rotate the scheduler token to ${schedulerScopes} and revoke the old token. It still has legacy vault access through ingest.`,
        ]
      : [],
    checks: {
      worker: check(Boolean(publicHealth && publicHealth.data), workerHint),
      health: check(
        Boolean(
          publicHealth && publicHealth.status === 200 && publicHealth.data?.ok,
        ),
        "Check the Worker URL and D1 binding. Run litscout deploy to apply the current migrations.",
      ),
      d1: check(
        details?.bindings?.DB === true && details.database.reachable,
        bindingsHint,
      ),
      kv: check(details?.bindings?.OAUTH_KV === true, bindingsHint),
      schema: {
        ...check(
          schemaVersion === SCHEMA_VERSION,
          readScope
            ? "Run litscout deploy to apply the current D1 migrations."
            : "Resolve the Worker and read token checks, then rerun doctor to verify the schema.",
        ),
        actual: schemaVersion,
        expected: SCHEMA_VERSION,
      },
      token: {
        ...check(
          readScope &&
            ingestScope &&
            (!vaultRequired || vaultScope) &&
            !!budget,
          retryToken
            ? tokenHint
            : "Resolve Worker and health checks before verifying the scheduler token.",
        ),
        present: !!token,
        read: readScope,
        ingest: ingestScope,
        vault: vaultScope,
        vaultRequired,
      },
    },
  };
}

function accessCheck(config: LitScoutConfig, trial: boolean) {
  const { teamDomain, aud } = config.access;
  const { webUrl, publicUrl } = config.instance;
  if (trial && publicUrl)
    // `server init --local`: the guide's Access steps do not apply.
    return {
      ok: true,
      configured: false,
      message: `A trial on this computer: the reader at ${new URL(publicUrl).origin}/app needs no sign-in.`,
    };
  const distinct =
    webUrl &&
    publicUrl &&
    new URL(webUrl).hostname !== new URL(publicUrl).hostname;
  if (!teamDomain && !aud && !distinct)
    return {
      ok: true,
      configured: false,
      message:
        "Access is disabled. Follow the self-host guide to open private browser routes.",
    };
  const configured =
    !!teamDomain &&
    /\.cloudflareaccess\.com$/i.test(teamDomain) &&
    !!aud &&
    !!distinct &&
    !!httpsBrowserOrigin(webUrl) &&
    !!httpsBrowserOrigin(publicUrl);
  return {
    ...check(
      configured,
      "Set instance.webUrl to the separate HTTPS Access browser hostname and copy access.teamDomain and access.aud from the private Access app.",
    ),
    configured,
  };
}

async function vaultChecks(
  config: LitScoutConfig["vault"],
  configPath: string,
) {
  const directory = path.dirname(configPath);
  const root = path.resolve(directory, config.root);
  const readable = await openVault(config, directory)
    .then(() => access(root, constants.R_OK | constants.X_OK))
    .then(
      () => true,
      () => false,
    );
  const valid = config.exclude.every(
    (glob) =>
      glob.trim() &&
      !/[\\\x00-\x1f]/.test(glob) &&
      !path.posix.isAbsolute(glob) &&
      !/^[a-z]:/i.test(glob) &&
      !glob.split("/").includes(".."),
  );
  const missing =
    !readable &&
    (await lstat(root).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    ));
  const hint = "Set vault.root to a readable local directory.";
  return {
    checks: {
      vaultRoot: { ...check(readable || missing, hint), configured: readable },
      vaultExcludes: check(
        valid,
        "Use vault-relative exclude globs with forward slashes and no parent-directory segments.",
      ),
      vaultWrite: { ok: true, enabled: config.write },
    },
    warnings:
      missing && config.write ? ["Vault writes are enabled. " + hint] : [],
  };
}

async function agentStatus(
  deps: SetupDeps,
  config: LitScoutConfig,
  live: boolean,
) {
  if (config.agent.mode === "none")
    return { agentChecks: [], agents: { ok: true, status: "skipped-no-llm" } };
  const chains = [config.agent.summaries, config.agent.digest].map(
    ({ client, fallback }) => [client, ...fallback],
  );
  const preflight = agentPreflight(deps, config.agent.api);
  const results = await Promise.all(
    [...new Set(chains.flat())].map((client) =>
      client === "api" && live
        ? liveApiCheck(deps, config.agent.api)
        : preflight(client),
    ),
  );
  return {
    agentChecks: results.map((result) => ({
      ...result,
      ...(result.client === "api" ? apiHost(config.agent.api) : {}),
      ...(result.usable
        ? {}
        : {
            hint:
              result.client === "api"
                ? "Check agent.api, the scheduler environment and the local API caps."
                : result.reason === "not found"
                  ? `Install ${result.client} or remove it from the configured client chain.`
                  : `Check sign-in and local access for ${result.client} from the scheduler account.`,
          }),
    })),
    agents: check(
      chains.every((chain) =>
        results.some(
          (result) => result.usable && chain.includes(result.client),
        ),
      ),
      'Configure a usable client for summaries and digest or set agent.mode to "none".',
    ),
  };
}

function usageWarnings(info: Awaited<ReturnType<typeof databaseUsage>>) {
  const warnings: string[] = [];
  if ((info?.database_size ?? 0) >= 300_000_000)
    warnings.push("D1 size is at least 300 MB");
  if ((info?.rows_read_24h ?? 0) >= 3_500_000)
    warnings.push("D1 reads reached 70% of a daily quota (rolling 24h proxy)");
  if ((info?.rows_written_24h ?? 0) >= 70_000)
    warnings.push("D1 writes reached 70% of a daily quota (rolling 24h proxy)");
  if (
    info &&
    (info.rows_read_24h === undefined || info.rows_written_24h === undefined)
  )
    warnings.push("Wrangler did not provide row metrics");
  return warnings;
}
export async function doctorCommand(
  deps: SetupDeps,
  config: LitScoutConfig,
  name: string,
  configPath = path.resolve(deps.cwd, "litscout.config.ts"),
  { readOnly = false, live = false } = {},
) {
  const resolved = await endpointConfig(config, deps.dir);
  config = resolved.config;
  const endpoint = config.instance.publicUrl;
  // On an own server, Wrangler, D1 usage, reconciliation and token listing
  // do not apply; the server's own report is checked instead.
  const where = await workerRuntime(deps, endpoint, readOnly);
  const onServer = where.runtime === "server";
  const wranglerStatus = onServer
    ? Promise.resolve({ wrangler: notUsed, wranglerLogin: notUsed })
    : wranglerChecks(deps);
  const infoRequest = wranglerStatus.then(({ wranglerLogin }) =>
    wranglerLogin.ok && endpoint && !onServer
      ? databaseUsage(deps, name)
      : null,
  );
  const reconciliationRequest = infoRequest.then((info) =>
    readOnly || onServer ? null : reconcileBudget(deps, info),
  );
  const tokenRequest = reconciliationRequest.then(async () => {
    const { wranglerLogin } = await wranglerStatus;
    return wranglerLogin.ok && endpoint && !onServer
      ? inspectTokens(deps, name)
      : { checked: false, warnings: [] };
  });
  const vaultRequest = vaultChecks(config.vault, configPath);
  // The daily runbook runs sync only in client mode with a configured vault.
  const requiresVault = vaultRequest.then(
    ({ checks }) =>
      readOnly ||
      (config.agent.mode === "client" && checks.vaultRoot.configured),
  );
  const [
    wrangler,
    worker,
    vault,
    { agents, agentChecks },
    info,
    reconciliation,
    tokens,
    legacy,
  ] = await Promise.all([
    wranglerStatus,
    workerChecks(
      deps,
      endpoint,
      readOnly,
      reconciliationRequest,
      requiresVault,
    ),
    vaultRequest,
    agentStatus(deps, config, live),
    infoRequest,
    reconciliationRequest,
    tokenRequest,
    legacyStatus(deps, config.legacy, endpoint, path.dirname(configPath)),
  ]);
  const server = onServer
    ? serverChecks(where.server, undefined, where.trial)
    : null;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const [major, minor] = nodeVersion.split(".").map(Number) as [number, number];
  const checks = {
    node: {
      ...check(
        major > 22 || (major === 22 && minor >= 13),
        "Install Node 22.13 or later.",
      ),
      version: nodeVersion,
    },
    ...wrangler,
    ...worker.checks,
    access: accessCheck(config, where.trial),
    agents,
    ...vault.checks,
    legacy,
    ...(server && { storage: server.storage }),
  };
  const retention =
    !readOnly && worker.checks.token.ingest
      ? await retentionReport(deps, config, true, true).catch(() => null)
      : null;
  const loggedIn = wrangler.wranglerLogin.ok;
  const warnings = [
    ...usageWarnings(info),
    ...(reconciliation?.warnings ?? []),
    ...tokens.warnings,
    ...worker.warnings,
    ...vault.warnings,
    ...profileWarnings(config.profile),
    ...(server?.warnings ?? []),
  ];
  if (
    reconciliation?.status === "unavailable" ||
    reconciliation?.status === "rolling-only"
  )
    warnings.push("D1 UTC-day reconciliation unavailable.");
  if (!endpoint)
    warnings.push("No instance.publicUrl or public URL recorded by deploy");
  if (loggedIn && endpoint && !info && !onServer)
    warnings.push(
      "D1 usage metrics unavailable. Check the selected Wrangler account and deployment name.",
    );
  return {
    failed: Object.values(checks).some(({ ok }) => !ok),
    data: {
      configValid: true,
      runtime: where.runtime,
      server: where.server,
      checks,
      budget: worker.budget,
      reconciliation,
      agentChecks,
      ...(!agentChecks.some(({ client }) => client === "api") &&
        config.agent.api && { apiHost: apiHost(config.agent.api).host }),
      publicUrl: endpoint ?? null,
      publicUrlSource: resolved.source,
      configPath,
      access: checks.access,
      tokensChecked: tokens.checked,
      authenticated: onServer ? null : loggedIn,
      health: checks.health.ok,
      usage: info,
      retention: {
        prunable: retention?.prunable ?? null,
        sizeBytes: retention?.sizeBytes ?? info?.database_size ?? null,
        databaseLimitBytes: onServer ? null : databaseLimitBytes,
      },
      warnings,
      usageWindow:
        "rolling 24 hours, per database; midnight UTC account totals unavailable from wrangler d1 info",
    },
  } satisfies CommandResult;
}
