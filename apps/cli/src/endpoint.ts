import type { LitScoutConfig } from "@litscout/core";
import { httpsBrowserOrigin } from "@litscout/core/config";
import { readState } from "./state";
export async function endpointConfig(config: LitScoutConfig, dir: string) {
  if (config.instance.publicUrl) return { config, source: "config" as const };
  const state = await readState(dir).catch(() => null);
  if (!state?.endpoint) return { config, source: "none" as const };
  return {
    config: {
      ...config,
      instance: {
        ...config.instance,
        publicUrl: state.endpoint,
        webUrl: config.instance.webUrl ?? httpsBrowserOrigin(state.endpoint),
      },
    },
    source: "deployment" as const,
  };
}
