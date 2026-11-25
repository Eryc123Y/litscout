import type { SourceLimiter } from "./limiter/source-limiter";
/** Bindings shared by source adapters and MCP, independent of the app. */
export interface SourceEnv {
  readonly OAUTH_KV: KVNamespace;
  readonly SOURCE_LIMITER: DurableObjectNamespace<SourceLimiter>;
  readonly CORE_API_KEY?: string;
  readonly S2_API_KEY?: string;
  readonly OPENALEX_API_KEY?: string;
}
