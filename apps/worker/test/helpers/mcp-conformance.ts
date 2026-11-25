import { createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import venues from "@litscout/core/test/fixtures/venues.json";
import { publicSourceFixtures } from "@litscout/mcp/test/helpers/public-sources";
import { webRuntime } from "./web-runtime";

export const origin = "https://litscout.example";
const managementToken = "fixture-management-token".repeat(2);
export const endpoint = new URL("/mcp", origin);
export const callback = "https://client.example/callback";

export async function mcpFixture(researchTools: boolean) {
  const sources = publicSourceFixtures();
  const runtime = await webRuntime({
    localDev: false,
    researchFixtures: true,
    unmatchedFixture: true,
    mcp: { origin, managementToken, researchTools },
    outboundService: (request) => sources.fetch(request.url),
  });
  try {
    await (
      await runtime.getKVNamespace("OAUTH_KV")
    ).put("litscout:venues", JSON.stringify(venues));
    const db = await runtime.getD1Database("DB");
    return {
      db,
      dispose: () => runtime.dispose(),
      async request(input: string | URL, init?: RequestInit) {
        const url = new URL(input, origin);
        if (url.origin !== origin) throw new Error("Unexpected fixture origin");
        return runtime.dispatchFetch(url.href, {
          ...(init as Parameters<typeof runtime.dispatchFetch>[1]),
          redirect: "manual",
        });
      },
      async token(
        suffix: string,
        scopes: string[],
        options?: {
          revokedAt?: string;
          expiresAt?: string;
        },
      ) {
        const token = "lsk_" + suffix.repeat(52);
        const hash = createHash("sha256").update(token).digest("hex");
        await db
          .prepare(
            "INSERT INTO api_tokens(id,name,hash,scopes,revoked_at,expires_at) VALUES (?,?,?,?,?,?)",
          )
          .bind(
            "tok_" + suffix,
            "Fixture " + suffix,
            hash,
            JSON.stringify(scopes),
            options?.revokedAt ?? null,
            options?.expiresAt ?? null,
          )
          .run();
        return token;
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export type McpFixture = Awaited<ReturnType<typeof mcpFixture>>;

export function mcpClient(
  fixture: McpFixture,
  credentials: string | OAuthClientProvider,
  ip?: string,
) {
  const client = new Client({ name: "litscout-conformance", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    // Miniflare uses Undici's Response types, while the SDK uses the runtime globals.
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (ip) headers.set("CF-Connecting-IP", ip);
      return (await fixture.request(input, {
        ...init,
        headers,
      })) as unknown as Response;
    },
    authProvider:
      typeof credentials === "string"
        ? { token: async () => credentials }
        : credentials,
  });
  return { client, transport };
}

export async function issuePairingCode(fixture: McpFixture) {
  const response = await fixture.request("/admin/pair", {
    method: "POST",
    headers: { authorization: "Bearer " + managementToken },
  });
  if (response.status !== 200)
    throw new Error(`Pairing failed: ${await response.text()}`);
  return z
    .object({ code: z.string(), endpoint: z.literal(endpoint.href) })
    .parse(await response.json()).code;
}

export function revokeClient(fixture: McpFixture, clientId: string) {
  return fixture.request("/admin/revoke", {
    method: "POST",
    headers: {
      authorization: "Bearer " + managementToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: clientId }),
  });
}
