import { SCHEMA_VERSION } from "@litscout/db";

const budget = {
  day: "2026-11-18",
  used: 0,
  reserved: 0,
  limit: 80000,
  staleLeasesReleased: 0,
  resetAt: "2026-11-19T00:00:00.000Z",
};
export function doctorResponse(
  input: RequestInfo | URL,
  usage = budget,
  token = { scopes: ["read", "ingest", "vault"], legacyVault: false },
  /** More health details, such as the runtime and the server's facts. */
  details: Record<string, unknown> = {},
) {
  switch (new URL(String(input)).pathname) {
    case "/health":
      return Response.json({ ok: true });
    case "/api/v1/health":
      return Response.json({
        success: true,
        data: {
          database: { reachable: true, schemaVersion: SCHEMA_VERSION },
          bindings: { DB: true, OAUTH_KV: true },
          token,
          ...details,
        },
      });
    case "/api/v1/budget":
      return Response.json({ success: true, data: usage });
    default:
      throw new Error("Unexpected doctor URL");
  }
}
