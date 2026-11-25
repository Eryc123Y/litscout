import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { configureWriteLimit } from "@litscout/db/write-budget";
import { createMcpHandler } from "agents/mcp/server";
import { apiTokenTouchDue, scopesSchema } from "@litscout/db";
import { apiTokenBearer, readApiToken } from "./auth/api-token";
import { limitBearerLookup, limitOAuthEndpoint } from "./auth/request-limit";
import { pairingStore } from "./auth/pairing-store";
import { authHandler } from "./auth/handler";
import type { AppEnv } from "./env";
import { buildServer } from "@litscout/mcp/server";
import { registerVaultTools } from "./mcp-vault";
import { registerLibraryTools } from "./mcp-library";
import { registerFeedTools } from "./mcp-feed";
import { logRequestError, unavailable } from "./diagnostics";
import { recordMcpTokenUse } from "./write-budget";

export { PairingStore } from "./auth/pairing-store";
export { SourceLimiter } from "@litscout/sources/limiter/source-limiter";

import { normaliseRequest } from "./request-path";
import { app, scheduled } from "./app";
import { setSecurityHeaders } from "./security-headers";

const MCP_ROUTE = "/mcp";

function serveMcp(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  access: Parameters<typeof registerLibraryTools>[2],
) {
  const handler = createMcpHandler(
    () =>
      buildServer(env, {
        read: access.read,
        researchTools: env.MCP_RESEARCH_TOOLS === "true",
        register: (server) => {
          registerLibraryTools(server, env, access);
          registerFeedTools(server, env, access);
          registerVaultTools(server, env, access);
        },
      }),
    { route: MCP_ROUTE },
  );
  return handler(request, env, ctx);
}

async function serveTokenMcp(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  authorization: string,
) {
  const unauthorized = () =>
    new Response(null, {
      status: 401,
      headers: { "www-authenticate": 'Bearer error="invalid_token"' },
    });
  if (!apiTokenBearer.test(authorization)) return unauthorized();
  if (!env.DB) return unavailable("Bearer authentication: DB binding missing");
  const denied = await limitBearerLookup(request, env, "mcp-token");
  if (denied) return denied;
  const token = await readApiToken(env.DB, authorization);
  if (!token) return unauthorized();
  const now = new Date();
  if (apiTokenTouchDue(token.lastUsedAt, now))
    ctx.waitUntil(
      recordMcpTokenUse(env.DB, token.id, now).catch(() => {
        logRequestError(new Error("Could not record MCP token use"), MCP_ROUTE);
      }),
    );
  const scopes = scopesSchema.safeParse(token.scopes);
  const read = scopes.data?.includes("read") === true;
  const write = scopes.data?.includes("write") === true;
  if (!read && !write) return new Response("Forbidden", { status: 403 });
  return serveMcp(request, env, ctx, {
    read,
    write,
    identity: "token:" + token.id,
    clientName: token.name,
  });
}

const mcpApiHandler: { fetch: ExportedHandlerFetchHandler<AppEnv> } = {
  async fetch(request, env, ctx) {
    const { props, auth } = ctx as ExecutionContext & {
      auth?: { scope: string[]; clientId?: string };
      props?: {
        authorizationId?: string;
        clientName?: string;
        libraryRead?: boolean;
        libraryWrite?: boolean;
      };
    };
    if (
      !props?.authorizationId ||
      !(await pairingStore(env).isActive(props.authorizationId))
    )
      return new Response("Forbidden", { status: 403 });
    return serveMcp(request as Request, env, ctx, {
      read:
        props.libraryRead === true &&
        (auth?.scope.includes("read") === true || auth?.scope.length === 0),
      write:
        props.libraryWrite === true && auth?.scope.includes("write") === true,
      identity: "mcp:" + (auth?.clientId ?? props.authorizationId),
      clientName: props.clientName,
    });
  },
};

function canonicalOrigin(publicUrl: string): string {
  const url = new URL(publicUrl);
  return `${url.protocol}//${url.host}`.toLowerCase();
}

export function createProvider(publicUrl: string): OAuthProvider<AppEnv> {
  const origin = canonicalOrigin(publicUrl);
  return new OAuthProvider<AppEnv>({
    apiRoute: MCP_ROUTE,
    apiHandler: mcpApiHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["read", "write"],
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: `${origin}${MCP_ROUTE}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "LitScout",
    },
  });
}

let cached: { url: string; provider: OAuthProvider<AppEnv> } | undefined;

function providerFor(env: AppEnv): OAuthProvider<AppEnv> {
  if (!cached || cached.url !== env.PUBLIC_URL) {
    cached = { url: env.PUBLIC_URL, provider: createProvider(env.PUBLIC_URL) };
  }
  return cached.provider;
}

async function serveOAuth(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  path: string,
) {
  const denied = await limitOAuthEndpoint(request, env, path);
  const response = denied ?? (await providerFor(env).fetch(request, env, ctx));
  const secured = new Response(response.body, response);
  setSecurityHeaders(secured.headers);
  return secured;
}

export default {
  fetch(request, env, ctx) {
    configureWriteLimit(env.WRITE_LIMIT);
    let safe: Request;
    try {
      safe = normaliseRequest(request as Request);
    } catch {
      return Response.json(
        {
          success: false,
          error: { code: "BAD_PATH", message: "Invalid request path" },
        },
        { status: 400 },
      );
    }
    const path = new URL(safe.url).pathname;
    const authorization = safe.headers.get("Authorization");
    if (path === MCP_ROUTE && authorization?.startsWith("Bearer lsk_"))
      return serveTokenMcp(safe, env, ctx, authorization);
    if (
      /^\/(?:mcp(?:\/|$)|oauth(?:\/|$)|authorize$|token$|register$|admin(?:\/|$)|\.well-known(?:\/|$))/.test(
        path,
      )
    )
      return serveOAuth(safe, env, ctx, path);
    return app.fetch(safe, env, ctx);
  },
  scheduled(event, env, ctx) {
    configureWriteLimit(env.WRITE_LIMIT);
    ctx.waitUntil(scheduled(env, event.scheduledTime));
  },
} satisfies ExportedHandler<AppEnv>;
