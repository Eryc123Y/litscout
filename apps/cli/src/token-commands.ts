import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import { tokenInput, scopesSchema } from "@litscout/db";
import { addCredential, removeCredential } from "./credentials-store";
import { readState } from "./state";
import { wranglerLine } from "./runtime";
import {
  UsageError,
  type SetupDeps,
  type CommandResult,
} from "./command-types";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes: Uint8Array) {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? result + alphabet[(value << (5 - bits)) & 31] : result;
}
function resultRows(raw: string): Record<string, unknown>[] {
  const parsed = z
    .array(z.object({ results: z.array(z.record(z.string(), z.unknown())) }))
    .parse(JSON.parse(raw));
  return parsed.flatMap((result) => result.results);
}
function executeArgs(deps: SetupDeps, database: string, command: string) {
  return [
    "d1",
    "execute",
    database,
    "--remote",
    "--config",
    path.join(deps.dir, "wrangler.jsonc"),
    "--command",
    command,
    "--json",
  ];
}
function execute(deps: SetupDeps, database: string, command: string) {
  return deps.run(executeArgs(deps, database, command));
}
export function tokenOptions(args: readonly string[]) {
  const [action, ...rest] = args;
  if (action === "create") return { action, ...createOptions(rest) } as const;
  if (action === "list" && rest.length === 0) return { action } as const;
  if (action === "revoke" && rest.length === 1) {
    const id = z
      .string()
      .regex(/^tok_[0-9A-HJKMNP-TV-Z]{26}$/)
      .parse(rest[0]);
    return { action, id } as const;
  }
  throw new UsageError(
    "Use token create --name NAME --scopes read,ingest,vault [--save-only] [--dry-run], token list, or token revoke ID",
  );
}
type TokenRecord = {
  id: string;
  name: string;
  hash: string;
  scopes: string[];
  expiresAt: string | null;
};
/** Where token rows live: the instance's admin routes, or D1 through Wrangler. */
interface TokenStore {
  insert(record: TokenRecord): Promise<void>;
  list(): Promise<Record<string, unknown>[]>;
  revoke(id: string): Promise<Record<string, unknown>[]>;
}
/** The instance answered 404: a Worker built before the token routes. */
class NoTokenRoutes extends Error {}
function wranglerStore(deps: SetupDeps, database: string): TokenStore {
  return {
    async insert(record) {
      await execute(
        deps,
        database,
        insertToken(
          record.id,
          record.hash,
          record.name,
          record.scopes,
          record.expiresAt,
        ),
      );
    },
    async list() {
      return resultRows(
        await execute(
          deps,
          database,
          "SELECT id,name,scopes,created_at,last_used_at,revoked_at,expires_at FROM api_tokens ORDER BY created_at DESC",
        ),
      );
    },
    async revoke(id) {
      return resultRows(
        await execute(
          deps,
          database,
          `UPDATE api_tokens SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='${id}' AND revoked_at IS NULL RETURNING id`,
        ),
      );
    },
  };
}
function adminStore(deps: SetupDeps, base: string, mgmt: string): TokenStore {
  const call = async (route: string, method: string, body?: unknown) => {
    const response = await deps.fetch(`${base}/admin/${route}`, {
      method,
      headers: {
        authorization: `Bearer ${mgmt}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404) throw new NoTokenRoutes();
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok)
      throw new UsageError(
        `Token request failed (HTTP ${response.status}${typeof data.error === "string" ? `: ${data.error}` : ""})`,
      );
    return data;
  };
  return {
    async insert(record) {
      await call("tokens", "POST", record);
    },
    async list() {
      return (await call("tokens", "GET")).tokens as Record<string, unknown>[];
    },
    async revoke(id) {
      return (await call("tokens/revoke", "POST", { id })).revoked as Record<
        string,
        unknown
      >[];
    },
  };
}
/** The management token and the instance address, when deploy saved them. */
async function adminAccess(deps: SetupDeps, url: string | undefined) {
  const state = await readState(deps.dir).catch(() => null);
  const base = url ?? state?.endpoint;
  return state?.token && base
    ? { base: base.replace(/\/$/, ""), mgmt: state.token }
    : null;
}
/**
 * Prefer the instance's admin routes, which work on Cloudflare and on an own
 * server; use Wrangler for a Worker deployed before they existed.
 */
async function withStore<T>(
  deps: SetupDeps,
  database: string,
  url: string | undefined,
  use: (store: TokenStore) => Promise<T>,
): Promise<T> {
  const access = await adminAccess(deps, url);
  if (access)
    try {
      return await use(adminStore(deps, access.base, access.mgmt));
    } catch (error) {
      if (!(error instanceof NoTokenRoutes)) throw error;
    }
  return use(wranglerStore(deps, database));
}
export async function tokenCommand(
  deps: SetupDeps,
  database: string,
  url: string | undefined,
  options: ReturnType<typeof tokenOptions>,
): Promise<CommandResult> {
  if (options.action === "create")
    return createToken(deps, database, url, options);
  const rows = await withStore(deps, database, url, (store) =>
    options.action === "list" ? store.list() : store.revoke(options.id),
  );
  return { data: rows, empty: rows.length === 0 };
}
function createOptions(args: readonly string[]) {
  const values: Record<string, string> = {};
  let dryRun = false;
  let saveOnly = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--dry-run" && !dryRun) {
      dryRun = true;
      continue;
    }
    // For agents, whose command output is kept in transcripts.
    if (key === "--save-only" && !saveOnly) {
      saveOnly = true;
      continue;
    }
    const value = args[++i];
    if (
      !["--name", "--scopes", "--expires-in"].includes(key) ||
      !value ||
      value.startsWith("-") ||
      values[key] !== undefined
    )
      throw new UsageError(
        "Use token create --name NAME --scopes read,ingest,vault [--expires-in DAYS] [--save-only] [--dry-run]",
      );
    values[key] = value;
  }
  const days =
    values["--expires-in"] === undefined
      ? null
      : z.coerce.number().int().min(1).max(36500).parse(values["--expires-in"]);
  return {
    name: tokenInput.shape.name.parse(values["--name"]),
    scopes: scopesSchema.parse(values["--scopes"]?.split(",")),
    days,
    dryRun,
    saveOnly,
  };
}
function insertToken(
  id: string,
  hash: string,
  name: string,
  scopes: string[],
  expiresAt: string | null,
) {
  return `INSERT INTO api_tokens(id,name,hash,scopes,expires_at) VALUES ('${id}','${name}','${hash}','${JSON.stringify(scopes)}',${expiresAt ? "'" + expiresAt + "'" : "NULL"})`;
}
async function createToken(
  deps: SetupDeps,
  database: string,
  url: string | undefined,
  { name, scopes, days, dryRun, saveOnly }: ReturnType<typeof createOptions>,
): Promise<CommandResult> {
  if (dryRun) {
    const admin = await adminAccess(deps, url);
    const sql = insertToken(
      "GENERATED_ID",
      "SHA256_OF_GENERATED_TOKEN",
      name,
      scopes,
      days === null ? null : "GENERATED_EXPIRY_UTC",
    );
    return {
      data: {
        name,
        scopes,
        expiresInDays: days,
        commands: [
          `# Generate a token and save the local credential privately in ${path.join(deps.dir, "credentials.json")}${url ? ` for ${new URL(url).origin}` : ""}.`,
          ...(admin
            ? [
                `# Send the record with the hash to ${admin.base}/admin/tokens with the management token; a Worker without that route uses:`,
              ]
            : []),
          wranglerLine(executeArgs(deps, database, sql)),
          saveOnly
            ? "# Store only the hash in D1. The token stays in the local credential and is not printed; remove the local entry if the insert fails."
            : "# Store only the hash in D1. Print the token once on success or remove the local entry if the insert fails.",
        ],
      },
    };
  }
  const token = "lsk_" + base32(randomBytes(32));
  const hash = createHash("sha256").update(token).digest("hex");
  const expiresAt =
    days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
  const id = `tok_${ulid()}`;
  await addCredential(deps.dir, {
    id,
    token,
    name,
    ...(url ? { url } : {}),
    expiresAt,
  });
  try {
    await withStore(deps, database, url, (store) =>
      store.insert({ id, name, hash, scopes, expiresAt }),
    );
  } catch {
    await removeCredential(deps.dir, id);
    throw new UsageError(
      "Token could not be stored remotely; local entry removed",
    );
  }
  return {
    data: {
      id,
      name,
      scopes,
      expiresAt,
      ...(saveOnly
        ? { saved: path.join(deps.dir, "credentials.json") }
        : { token }),
    },
  };
}
