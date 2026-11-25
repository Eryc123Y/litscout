import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { migrationFiles, migrationStatements } from "@litscout/db/test/harness";
type RuntimeOptions = {
  entryPoint?: string;
  bindings?: Record<string, string>;
  kvNamespaces?: string[];
  scheduled?: boolean;
  persistence?: { path: string; initialized: boolean; through?: string };
  outboundService?: (request: Request) => Response | Promise<Response>;
};
export async function securityWorker(options: RuntimeOptions = {}) {
  const { outputFiles } = await build({
    entryPoints: [options.entryPoint ?? "apps/worker/src/index.ts"],
    write: false,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: '"security-test"' },
  });
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: outputFiles[0]!.text,
      host: "127.0.0.1",
      cf: false,
      stripCfConnectingIp: !options.persistence,
      resourcePersistencePath: options.persistence?.path,
      telemetry: { enabled: false },
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      d1Databases: ["DB"],
      bindings: options.bindings,
      kvNamespaces: ["OAUTH_KV", ...(options.kvNamespaces ?? [])],
      unsafeTriggerHandlers: options.scheduled,
      durableObjects: {
        PAIRING_STORE: { className: "PairingStore", useSQLite: true },
        SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
      },
      outboundService:
        options.outboundService ??
        (() => new Response("Network disabled", { status: 503 })),
    }),
  );
  const db = await worker.getD1Database("DB");
  if (!options.persistence?.initialized) {
    const through = options.persistence?.through;
    const files = through
      ? migrationFiles.filter((file) => file.slice(0, 4) <= through)
      : migrationFiles;
    for (const sql of migrationStatements(files)) await db.prepare(sql).run();
  }
  const tokens = {
    ingest: "lsk_" + "I".repeat(52),
    admin: "lsk_" + "A".repeat(52),
    read: "lsk_" + "R".repeat(52),
    vault: "lsk_" + "V".repeat(52),
  };
  for (const [scope, token] of Object.entries(tokens)) {
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ).toString("hex");
    await db
      .prepare(
        "INSERT OR IGNORE INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)",
      )
      .bind(
        "tok_" + scope,
        scope,
        hash,
        JSON.stringify(
          scope === "admin" ? ["ingest", "read", "write"] : [scope],
        ),
      )
      .run();
  }
  const endpoint = await worker.getWorker();
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    scope: keyof typeof tokens = method === "GET" ? "read" : "ingest",
  ) =>
    endpoint.fetch("https://local/api/v1" + path, {
      method,
      headers: {
        authorization: "Bearer " + tokens[scope],
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { worker, db, call, tokens, endpoint };
}
