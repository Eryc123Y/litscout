import { z } from "zod";
import path from "node:path";
import type { SetupDeps } from "./command-types";
const tokensSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime().nullable(),
    revoked_at: z.iso.datetime().nullable().optional(),
  }),
);
export function tokenWarnings(input: unknown, now = Date.now()) {
  const tokens = tokensSchema.parse(input).filter((t) => !t.revoked_at);
  const day = 86400000;
  return tokens.flatMap((t) =>
    t.expires_at
      ? Date.parse(t.expires_at) > now &&
        Date.parse(t.expires_at) <= now + 14 * day
        ? [`Token ${t.id} expires within 14 days`]
        : []
      : now - Date.parse(t.created_at) > 180 * day
        ? [`Token ${t.id} has no expiry and is older than 180 days`]
        : [],
  );
}
export async function inspectTokens(deps: SetupDeps, name: string) {
  try {
    const raw = await deps.run([
      "d1",
      "execute",
      `${name}-db`,
      "--remote",
      "--config",
      path.join(deps.dir, "wrangler.jsonc"),
      "--command",
      "SELECT id,name,created_at,expires_at,revoked_at FROM api_tokens",
      "--json",
    ]);
    const response = z
      .array(z.object({ results: z.array(z.unknown()) }))
      .parse(JSON.parse(raw));
    return {
      checked: true,
      warnings: tokenWarnings(response.flatMap((r) => r.results)),
    };
  } catch {
    return { checked: false, warnings: ["Token expiry checks unavailable"] };
  }
}
