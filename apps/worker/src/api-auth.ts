import { apiJson } from "./api-response";
import type { ApiPayload } from "./api-response";
import { getCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  teamDomainSchema,
  accessAudienceSchema,
  loopbackHost,
} from "@litscout/core";
import { scopesSchema, type TokenScope } from "@litscout/db";
import { apiTokenBearer, readApiToken } from "./auth/api-token";
import { limitBearerLookup } from "./auth/request-limit";
import type { AppEnv } from "./env";
import { unavailable } from "./diagnostics";
import { isTrial } from "./server-status";
import type { preparePaperIngest } from "@litscout/db/ingest-papers";
export type WorkerBindings = {
  Bindings: AppEnv;
  Variables: {
    ingestBody: unknown;
    apiPayload?: { body: ApiPayload; status: number };
    budgetRowsWritten?: number;
    summaryCounterAllowance?: number;
    paperIngestPlan?: Awaited<ReturnType<typeof preparePaperIngest>>;
    authRowsWritten: number;
    tokenScopes: TokenScope[];
    apiToken: { id: string; lastUsedAt: string | null; legacyVault: boolean };
  };
};
const accessConfig = z.object({
  ACCESS_TEAM_DOMAIN: teamDomainSchema,
  ACCESS_AUD: accessAudienceSchema,
});
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const failure = (code: string, message: string) => ({
  success: false as const,
  error: { code, message },
});
const ownerScopes: TokenScope[] = ["read", "ingest", "write", "vault"];
export function requiredScope(method: string, path: string): TokenScope {
  if (path === "/api/v1/backup" || path.startsWith("/api/v1/backup/"))
    return "write";
  if (
    ["GET", "HEAD"].includes(method) &&
    ["/api/v1/vault/status", "/api/v1/vault/captures"].includes(path)
  )
    return "write";
  if (
    ["GET", "HEAD"].includes(method) &&
    /^\/api\/v1\/vault\/(?:index(?:\/ids)?|requests|matches|papers|digests\/[^/]+|budget)$/.test(
      path,
    )
  )
    return "vault";
  if (
    (method === "PUT" && /^\/api\/v1\/vault\/(?:index|report)$/.test(path)) ||
    (method === "POST" &&
      /^\/api\/v1\/vault\/requests\/[^/]+\/(?:resolve|claim)$/.test(path))
  )
    return "vault";
  // The prune and expiry previews name papers and why each is kept, which is
  // private reading state; the deletes themselves stay ingest calls.
  if (
    ["GET", "HEAD"].includes(method) &&
    (path === "/api/v1/ingest/prune" || path === "/api/v1/ingest/expire")
  )
    return "read";
  if (
    ["GET", "HEAD"].includes(method) &&
    (path === "/api/v1/budget" || path.startsWith("/api/v1/ingest/"))
  )
    return "ingest";
  if (["GET", "HEAD"].includes(method)) return "read";
  return path.startsWith("/api/v1/ingest/") ||
    (method === "PUT" && path.startsWith("/api/v1/digests/"))
    ? "ingest"
    : "write";
}
export async function verifyAccess(jwt: string, env: AppEnv): Promise<boolean> {
  const parsed = accessConfig.safeParse(env);
  if (!parsed.success) return false;
  const { ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: audience } = parsed.data;
  const issuer = `https://${domain}`;
  let keySet = jwks.get(domain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(domain, keySet);
  }
  try {
    await jwtVerify(jwt, keySet, { issuer, audience, algorithms: ["RS256"] });
    return true;
  } catch {
    return false;
  }
}
/** Headers a reverse proxy, a tunnel or Cloudflare adds to a request. */
const forwardedHeaders = [
  "Forwarded",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Real-IP",
  "Via",
  "CF-Ray",
  "Cf-Access-Jwt-Assertion",
];
const fromThisComputer = (peer: string | undefined) =>
  peer === undefined || loopbackHost(peer.includes(":") ? `[${peer}]` : peer);
/** A trial on the reader's own computer (apps/server with `local`): there is
 * no Access in front, and a request addressed to this computer is the
 * owner's. Three things are refused:
 * - any other host name: a foreign page whose name resolves to 127.0.0.1
 *   would otherwise read and write as the owner (DNS rebinding);
 * - any port but the server's own;
 * - a request that came through a proxy or a tunnel, which can hand on a
 *   loopback Host: the switch copied onto a real server must not make every
 *   visitor the owner. Miniflare itself sets CF-Connecting-IP to the address
 *   the connection came from, so that one header must name this computer.
 * Returns undefined when the instance is not such a trial. */
function localOwner(c: Context<WorkerBindings>) {
  if (!isTrial(c.env)) return undefined;
  const url = new URL(c.req.url);
  const own = URL.canParse(c.env.PUBLIC_URL)
    ? new URL(c.env.PUBLIC_URL)
    : undefined;
  return (
    loopbackHost(url.hostname) &&
    url.protocol === "http:" &&
    url.port === own?.port &&
    !forwardedHeaders.some((name) => c.req.header(name) !== undefined) &&
    fromThisComputer(c.req.header("CF-Connecting-IP"))
  );
}
async function bearerAuth(c: Context<WorkerBindings>, authorization: string) {
  if (!apiTokenBearer.test(authorization))
    return apiJson(c, failure("UNAUTHORIZED", "Unauthorized"), 401);
  if (!c.env.DB)
    return unavailable("Bearer authentication: DB binding missing");
  // Check the failure budget before D1. Valid tokens leave it untouched.
  const limited = await limitBearerLookup(c.req.raw, c.env, "rest-token", {
    count: false,
  });
  if (limited) return limited;
  const stored = await readApiToken(c.env.DB, authorization);
  if (!stored) {
    const denied = await limitBearerLookup(c.req.raw, c.env, "rest-token");
    return denied ?? apiJson(c, failure("UNAUTHORIZED", "Unauthorized"), 401);
  }
  const scopes = scopesSchema.safeParse(stored.scopes);
  const required = requiredScope(c.req.method, c.req.path);
  const legacyVault =
    stored.legacyVault === true &&
    scopes.data?.includes("ingest") === true &&
    !scopes.data.includes("vault");
  if (
    !scopes.success ||
    (!scopes.data.includes(required) && !(required === "vault" && legacyVault))
  )
    return apiJson(
      c,
      failure("FORBIDDEN", "Token does not have the required scope"),
      403,
    );
  c.set("tokenScopes", scopes.data);
  c.set("apiToken", {
    id: stored.id,
    lastUsedAt: stored.lastUsedAt,
    legacyVault,
  });
  return null;
}
export const privateAuth: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  if (
    ["GET", "HEAD"].includes(c.req.method) &&
    c.req.path.startsWith("/api/v1/public/")
  )
    return next();
  if (
    ["GET", "HEAD"].includes(c.req.method) &&
    c.req.path === "/api/v1/instance"
  ) {
    if (c.env.PUBLIC_FEED !== "true") {
      const limited = await authenticateInstance(c);
      if (limited) return limited;
    }
    return next();
  }
  const authorization = c.req.header("Authorization");
  if (authorization !== undefined && c.req.path.startsWith("/api/v1/")) {
    const denied = await bearerAuth(c, authorization);
    return denied ?? next();
  }
  if (["/api/v1/health", "/api/v1/vault/health"].includes(c.req.path))
    return apiJson(c, failure("UNAUTHORIZED", "Unauthorized"), 401);
  if (c.env.LOCAL_DEV === "true") {
    c.set("tokenScopes", ownerScopes);
    return next();
  }
  const local = localOwner(c);
  if (local === false)
    return apiJson(c, failure("UNAUTHORIZED", "Unauthorized"), 401);
  if (local) {
    c.set("tokenScopes", ownerScopes);
    return next();
  }
  if (!accessConfig.safeParse(c.env).success)
    return unavailable("Access requires ACCESS_TEAM_DOMAIN and ACCESS_AUD");
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  if (!jwt || !(await verifyAccess(jwt, c.env)))
    return apiJson(c, failure("UNAUTHORIZED", "Unauthorized"), 401);
  c.set("tokenScopes", ownerScopes);
  return next();
};

/** Optional authentication must not block the generic signed-out landing. */
async function authenticateInstance(c: Context<WorkerBindings>) {
  const authorization = c.req.header("Authorization");
  if (authorization !== undefined) {
    const denied = await bearerAuth(c, authorization);
    return denied?.status === 429 ? denied : undefined;
  }
  if (c.env.LOCAL_DEV === "true" || localOwner(c)) {
    c.set("tokenScopes", ownerScopes);
    return;
  }
  const jwt =
    c.req.header("Cf-Access-Jwt-Assertion") ?? getCookie(c, "CF_Authorization");
  if (jwt && (await verifyAccess(jwt, c.env)))
    c.set("tokenScopes", ownerScopes);
}
