import { z } from "zod";
import { scopesSchema, tokenInput } from "@litscout/db";
import type { AppEnv } from "../env";

/**
 * API token management for the management token holder. The CLI generates
 * the token and sends only its SHA-256 hash, as it does when it writes D1
 * directly; the server never sees or returns a token.
 */
const tokenId = z.string().regex(/^tok_[0-9A-HJKMNP-TV-Z]{26}$/);
const newToken = z.strictObject({
  id: tokenId,
  name: tokenInput.shape.name,
  hash: tokenInput.shape.hash,
  scopes: scopesSchema,
  expiresAt: z.iso.datetime().nullable(),
});
const revoke = z.strictObject({ id: tokenId });

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

async function body<T>(req: Request, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** Handles /admin/tokens routes; null for any other path. */
export async function adminTokens(
  req: Request,
  env: AppEnv,
  path: string,
): Promise<Response | null> {
  if (path !== "/admin/tokens" && path !== "/admin/tokens/revoke") return null;
  if (!env.DB)
    return json({ error: "Database binding DB is not configured" }, 503);
  if (path === "/admin/tokens" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id,name,scopes,created_at,last_used_at,revoked_at,expires_at FROM api_tokens ORDER BY created_at DESC",
    ).all();
    return json({ tokens: results });
  }
  if (path === "/admin/tokens" && req.method === "POST") {
    const token = await body(req, newToken);
    if (!token) return json({ error: "Invalid token record" }, 400);
    if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())
      return json({ error: "Expiry must be in the future" }, 400);
    const existing = await env.DB.prepare(
      "SELECT 1 AS found FROM api_tokens WHERE id=? OR hash=?",
    )
      .bind(token.id, token.hash)
      .first();
    if (existing) return json({ error: "Token already exists" }, 409);
    await env.DB.prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes,expires_at) VALUES (?,?,?,?,?)",
    )
      .bind(
        token.id,
        token.name,
        token.hash,
        JSON.stringify(token.scopes),
        token.expiresAt,
      )
      .run();
    return json({ created: token.id }, 201);
  }
  if (path === "/admin/tokens/revoke" && req.method === "POST") {
    const input = await body(req, revoke);
    if (!input) return json({ error: "Token id required" }, 400);
    const { results } = await env.DB.prepare(
      "UPDATE api_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revoked_at IS NULL RETURNING id",
    )
      .bind(input.id)
      .all();
    return json({ revoked: results });
  }
  return json({ error: "Method not allowed" }, 405);
}
