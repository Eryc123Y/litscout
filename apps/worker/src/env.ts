/** Worker bindings, vars and secrets. Secrets are optional at the type level and checked at use. */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { SourceLimiter } from "@litscout/sources/limiter/source-limiter";

export interface AppEnv {
  readonly DB?: D1Database;
  readonly ASSETS?: Fetcher;
  readonly ACCESS_TEAM_DOMAIN?: string;
  readonly ACCESS_AUD?: string;
  readonly LOCAL_DEV?: string;
  /** "true" on an own server run as a trial on the reader's computer: a
   * request addressed to the loopback interface is the owner's. Set by
   * apps/server from `local` in server.json, never as a variable. */
  readonly LOCAL_OWNER?: string;
  /** Instance daily write caps, for example "save:200,activity:2000". */
  readonly LIBRARY_DAILY_CAPS?: string;
  /** "off" skips the public read limiter, and only together with LOCAL_DEV. */
  readonly PUBLIC_RATE_LIMIT?: string;
  /** "off" skips the export cooldown, and only together with LOCAL_DEV. */
  readonly BACKUP_COOLDOWN?: string;
  readonly PUBLIC_FEED?: string;
  readonly CRON_CRAWL_TRIAL?: string;
  readonly CRON_CRAWL_STAGE?: KVNamespace;
  readonly STORAGE_CONFIG?: string;
  readonly INSTANCE_CONFIG?: string;
  readonly HEALTH_ON_TIME_BY?: string;
  /** Rows written a day; default 80,000 for the Cloudflare D1 Free plan. */
  readonly WRITE_LIMIT?: string;
  /** "server" when apps/server runs the bundle on an own server. */
  readonly LITSCOUT_RUNTIME?: string;
  readonly VAULT_NAME?: string;
  readonly VAULT_CONVENTIONS?: string;
  readonly PAIRING_STORE: DurableObjectNamespace<
    import("./auth/pairing-store").PairingStore
  >;
  readonly MGMT_TOKEN?: string;
  readonly OAUTH_KV: KVNamespace;
  readonly SOURCE_LIMITER: DurableObjectNamespace<SourceLimiter>;
  /** Injected by OAuthProvider into the default handler. */
  readonly OAUTH_PROVIDER?: OAuthHelpers;

  readonly PUBLIC_URL: string;

  readonly CONSENT_SECRET?: string;
  readonly MCP_RESEARCH_TOOLS?: string;
  readonly UNPAYWALL_EMAIL?: string;
  readonly CORE_API_KEY?: string;
  readonly S2_API_KEY?: string;
  readonly OPENALEX_API_KEY?: string;
}
