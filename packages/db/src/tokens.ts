import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { tokenInput } from "./contracts";
import { first, rows, type Database } from "./database";
import type { apiTokens } from "./schema";
export type ApiToken = typeof apiTokens.$inferSelect;
export async function createApiToken(
  db: Database,
  input: unknown,
): Promise<ApiToken> {
  const v = tokenInput.parse(input);
  const id = `tok_${ulid()}`;
  const row = await first<ApiToken>(
    db,
    sql`INSERT INTO api_tokens(id,name,hash,scopes,expires_at) VALUES (${id},${v.name},${v.hash},${JSON.stringify(v.scopes)},${v.expiresAt}) RETURNING *`,
  );
  return row!;
}
export function findApiToken(
  db: Database,
  hash: string,
  now = new Date().toISOString(),
) {
  return first<ApiToken>(
    db,
    sql`SELECT * FROM api_tokens WHERE hash=${hash} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${new Date(now).toISOString()})`,
  );
}
export function listApiTokens(db: Database) {
  return rows<Omit<ApiToken, "hash" | "legacyVault">>(
    db,
    sql`SELECT id,name,scopes,created_at,last_used_at,revoked_at,expires_at FROM api_tokens ORDER BY created_at DESC`,
  );
}
export async function revokeApiToken(db: Database, id: string) {
  await db.run(
    sql`UPDATE api_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=${id} AND revoked_at IS NULL`,
  );
}
const touchIntervalMs = 60_000;

export function apiTokenTouchDue(lastUsedAt: string | null, now: Date) {
  return (
    !lastUsedAt || Date.parse(lastUsedAt) <= now.getTime() - touchIntervalMs
  );
}

export async function touchApiToken(db: Database, id: string, now: string) {
  const cutoff = new Date(Date.parse(now) - touchIntervalMs).toISOString();
  const result = await db.run(
    sql`UPDATE api_tokens SET last_used_at=${now} WHERE id=${id} AND (last_used_at IS NULL OR last_used_at<=${cutoff})`,
  );
  return "meta" in result ? result.meta.rows_written : result.changes;
}
