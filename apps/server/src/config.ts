import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Must match `apps/worker/wrangler.template.jsonc`. */
export const compatibilityDate = "2026-10-01";
export const compatibilityFlags = [
  "nodejs_compat",
  "global_fetch_strictly_public",
];

const secretNames = [
  "MGMT_TOKEN",
  "CONSENT_SECRET",
  "S2_API_KEY",
  "OPENALEX_API_KEY",
  "CORE_API_KEY",
  "UNPAYWALL_EMAIL",
] as const;
/** Switches meant for local tests only; never part of a running server. */
const developmentOnly = ["LOCAL_DEV", "PUBLIC_RATE_LIMIT", "BACKUP_COOLDOWN"];
/** An address only this computer can reach. */
const loopback = (host: string) =>
  ["localhost", "::1", "[::1]"].includes(host) ||
  /^127(?:\.\d{1,3}){3}$/.test(host);

const serverConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  /** A trial on this computer: no sign-in, and reachable from here only. */
  local: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8787),
  /** The CLI's build folder: worker.js, web/ and migrations/. */
  app: z.string().min(1),
  /** Where D1, KV and Durable Object data are kept. */
  state: z.string().min(1),
  /** The Worker's plain variables, as deployed on Cloudflare. */
  vars: z.record(z.string(), z.string()),
  /** KEY=VALUE lines with the Worker's secrets; mode 600. */
  secretsFile: z.string().optional(),
  /** Daily UTC time of the Worker's scheduled handler. */
  cronUtc: z
    .string()
    .regex(/^\d\d:\d\d$/)
    .default("02:00"),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type Secrets = Partial<Record<(typeof secretNames)[number], string>>;

export function parseSecrets(text: string): Secrets {
  const secrets: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    const key = at === -1 ? line : line.slice(0, at);
    if (!(secretNames as readonly string[]).includes(key))
      throw new Error(`Unknown secret ${key} in the secrets file`);
    secrets[key] = line.slice(at + 1);
  }
  return secrets as Secrets;
}

/** A trial has no sign-in, so nothing beyond this computer may reach it. */
function checkLocal(config: ServerConfig) {
  if (!loopback(config.host))
    throw new Error(
      `"local": true serves this computer only; host must be 127.0.0.1, not ${config.host}`,
    );
  const address = config.vars.PUBLIC_URL ?? "";
  const url = URL.canParse(address) ? new URL(address) : undefined;
  if (
    url?.protocol !== "http:" ||
    !loopback(url.hostname) ||
    Number(url.port || 80) !== config.port
  )
    throw new Error(
      `With "local": true, vars.PUBLIC_URL must be this computer's address, http://127.0.0.1:${config.port}`,
    );
}

export function loadServerConfig(file: string) {
  const config = serverConfigSchema.parse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  for (const key of developmentOnly)
    if (key in config.vars)
      throw new Error(`${key} is for local tests only; remove it from vars`);
  if ("LOCAL_OWNER" in config.vars)
    throw new Error('LOCAL_OWNER is not a variable; set "local": true instead');
  if (config.local) checkLocal(config);
  else if (!/^https:\/\//.test(config.vars.PUBLIC_URL ?? ""))
    throw new Error("vars.PUBLIC_URL must be the public https address");
  let secrets: Secrets = {};
  if (config.secretsFile) {
    const secretsFile = path.resolve(path.dirname(file), config.secretsFile);
    if ((statSync(secretsFile).mode & 0o077) !== 0)
      throw new Error(`${secretsFile} must be mode 600`);
    secrets = parseSecrets(readFileSync(secretsFile, "utf8"));
  }
  return { config, secrets };
}

/** Miniflare options that run the deployed Worker bundle with saved data. */
export function workerOptions(config: ServerConfig, secrets: Secrets) {
  return {
    modules: true,
    // Module names are relative to this folder. The default, the working
    // directory, gives names with ".." that workerd refuses.
    modulesRoot: config.app,
    scriptPath: path.join(config.app, "worker.js"),
    compatibilityDate,
    compatibilityFlags,
    host: config.host,
    port: config.port,
    // No request.cf data: nothing reads it, and fetching it needs the network.
    cf: false,
    d1Databases: ["DB"],
    kvNamespaces: ["OAUTH_KV"],
    durableObjects: {
      PAIRING_STORE: { className: "PairingStore", useSQLite: true },
      SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
    },
    assets: {
      directory: path.join(config.app, "web"),
      binding: "ASSETS",
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
    },
    // The Worker shows the server's facts instead of Cloudflare's.
    bindings: {
      ...config.vars,
      ...secrets,
      LITSCOUT_RUNTIME: "server",
      ...(config.local ? { LOCAL_OWNER: "true" } : {}),
    },
    resourcePersistencePath: config.state,
  };
}
