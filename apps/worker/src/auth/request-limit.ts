import type { AppEnv } from "../env";
import { digest } from "./crypto";
import type { PairingStore } from "./pairing-store";
import { z } from "zod";

export function allowLimitedRequest(
  env: AppEnv,
  bucket: string,
  ...limits: Parameters<PairingStore["allowRequest"]>
) {
  return env.PAIRING_STORE.get(
    env.PAIRING_STORE.idFromName(`http:${bucket}`),
  ).allowRequest(...limits);
}
const ipv4 = z.ipv4();
const ipv6 = z.ipv6();
const bearerLookupsPerMinute = 120;
const ipLimits = {
  admin: 30,
  authorize: 10,
  "authorize-page": 10,
  register: 10,
  token: 10,
  public: 60,
  "mcp-token": bearerLookupsPerMinute,
  "rest-token": bearerLookupsPerMinute,
};

function ipKey(request: Request, subnet: boolean) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return "unknown";
  if (ipv4.safeParse(ip).success) return ip;
  if (!ipv6.safeParse(ip).success) return "unknown";
  if (!subnet) return ip;
  // URL parsing canonicalizes IPv6, including embedded IPv4. Expand the
  // compressed zeroes before retaining the four network-side groups.
  const address = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const [prefix, suffix] = address.split("::");
  const head = prefix ? prefix.split(":") : [];
  if (suffix !== undefined) {
    const tail = suffix ? suffix.split(":") : [];
    head.push(
      ...Array<string>(8 - head.length - tail.length).fill("0"),
      ...tail,
    );
  }
  return head.slice(0, 4).join(":") + "::/64";
}

function rateLimited(retryAfter: number, message = "Too many requests") {
  return Response.json(
    { success: false, error: { code: "RATE_LIMITED", message } },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

async function limitIp(
  request: Request,
  env: AppEnv,
  scope: keyof typeof ipLimits,
  { subnet = false, count = true } = {},
): Promise<Response | null> {
  const key = await digest(ipKey(request, subnet));
  if (scope === "public" && new URL(request.url).searchParams.has("q")) {
    const result = await allowLimitedRequest(env, `public-search:${key}`, 10);
    if (!result.allowed)
      return rateLimited(result.retryAfter, "Too many searches");
  }
  const result = await allowLimitedRequest(
    env,
    `${scope}:${key}`,
    ipLimits[scope],
    "minute",
    count,
  );
  return result.allowed ? null : rateLimited(result.retryAfter);
}

export function limitBearerLookup(
  request: Request,
  env: AppEnv,
  scope: "mcp-token" | "rest-token",
  options?: { count: boolean },
) {
  return limitIp(request, env, scope, options);
}

export function limitOAuthEndpoint(
  request: Request,
  env: AppEnv,
  path: string,
) {
  if (path === "/authorize" && request.method === "GET")
    return limitIp(request, env, "authorize-page", { subnet: true });
  if (request.method === "POST" && (path === "/register" || path === "/token"))
    return limitIp(request, env, path === "/register" ? "register" : "token", {
      subnet: true,
    });
  return null;
}
/** The local end-to-end server runs one export per browser project. */
export function backupCooldownOff(
  env: Pick<AppEnv, "LOCAL_DEV" | "BACKUP_COOLDOWN">,
) {
  return env.LOCAL_DEV === "true" && env.BACKUP_COOLDOWN === "off";
}
/**
 * Local end-to-end runs send every request from one address, so a serial
 * desktop and phone run would hit the public limit. Only a local development
 * Worker may turn it off.
 */
export function publicLimitOff(
  env: Pick<AppEnv, "LOCAL_DEV" | "PUBLIC_RATE_LIMIT">,
) {
  return env.LOCAL_DEV === "true" && env.PUBLIC_RATE_LIMIT === "off";
}
/** Cloudflare overwrites this header; X-Forwarded-For is deliberately ignored. */
export async function limitRequest(
  request: Request,
  env: AppEnv,
  path: string,
): Promise<Response | null> {
  const scope = path.startsWith("/admin/")
    ? "admin"
    : path === "/authorize" && request.method === "POST"
      ? "authorize"
      : path.startsWith("/api/v1/public/") &&
          ["GET", "HEAD"].includes(request.method)
        ? "public"
        : null;
  if (!scope) return null;
  if (scope === "public" && publicLimitOff(env)) return null;
  return limitIp(request, env, scope);
}
