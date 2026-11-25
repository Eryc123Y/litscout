import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "../env";
import { limitRequest } from "./request-limit";
import { unavailable } from "../diagnostics";
import { admin } from "./admin";
import { pairingStore } from "./pairing-store";
import { consentPage, continueToClientPage, messagePage } from "./pages";
import { libraryPermissions } from "./library-permissions";

function returnToClient(
  req: Request,
  redirectTo: string,
  headers = new Headers(),
) {
  headers.set("Cache-Control", "no-store");
  if (
    req.method === "POST" &&
    req.headers.get("Sec-Fetch-Mode") === "navigate"
  ) {
    // A direct cross-origin form redirect can be blocked by form-action.
    // Finish the form on this origin, then navigate back to the OAuth client.
    headers.delete("Location");
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Refresh", `0; url=${redirectTo}`);
    return new Response(continueToClientPage(redirectTo), { headers });
  }
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

async function authorize(req: Request, env: AppEnv): Promise<Response> {
  if (
    !env.CONSENT_SECRET ||
    env.CONSENT_SECRET.length < 32 ||
    !env.OAUTH_PROVIDER
  )
    return unavailable("OAuth requires CONSENT_SECRET and OAUTH_PROVIDER");
  const oauth = env.OAUTH_PROVIDER;
  if (req.method === "GET") {
    const request = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    consent.headers.set("content-type", "text/html; charset=utf-8");
    consent.headers.set("cache-control", "no-store");
    return new Response(consentPage(details, consent.handle), {
      headers: consent.headers,
    });
  }
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return returnToClient(req, denied.redirectTo, denied.headers);
  }
  // Validate browser binding before using a pairing attempt. Never bypass pairing via a cookie.
  const approved = await oauth.approveConsent(req, handle, {
    remember: { secret: env.CONSENT_SECRET, subject: "owner" },
  });
  const authorizationId = await pairingStore(env).consume(
    String(form.get("code") ?? ""),
    approved.request.clientId,
    handle,
  );
  if (!authorizationId)
    return messagePage(
      "Pairing failed",
      "Invalid or expired code. Restart authorization from your connector and try again.",
      403,
    );
  const client = await oauth
    .lookupClient(approved.request.clientId)
    .catch(() => null);
  const clientName =
    client?.clientName
      ?.replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 100) || approved.request.clientId;
  const scopes = approved.request.scope;
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: "owner",
    metadata: { clientId: approved.request.clientId },
    scope: scopes.length ? scopes : ["read"],
    props: { authorizationId, clientName, ...libraryPermissions(scopes) },
  });
  return returnToClient(req, redirectTo, approved.headers);
}
export const authHandler: {
  fetch: (
    req: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ) => Promise<Response>;
} = {
  async fetch(req, env) {
    try {
      const path = new URL(req.url).pathname;
      const denied = await limitRequest(req, env, path);
      if (denied) return denied;
      if (path.startsWith("/admin/")) return await admin(req as Request, env);
      if (path === "/authorize") return await authorize(req as Request, env);
      if (path === "/" && req.method === "GET")
        return new Response(`LitScout MCP: ${env.PUBLIC_URL}/mcp`);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo)
        return returnToClient(req, error.redirectTo);
      if (error instanceof CimdFetchError)
        return messagePage(
          "Authorization failed",
          "Client metadata could not be verified.",
          400,
        );
      return messagePage(
        "Request failed",
        "Invalid request or expired browser session; start again from your connector.",
        400,
      );
    }
  },
};
