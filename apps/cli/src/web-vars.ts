import path from "node:path";
import { vaultTagLabel, type LitScoutConfig } from "@litscout/core";
import { topVenueNames } from "./venue-crawl";
/** Vault settings stay outside the public display config. */
export function webVars(config: LitScoutConfig, topVenues: string[] = []) {
  return {
    VAULT_NAME:
      config.vault.name ?? (path.basename(config.vault.root) || "vault"),
    VAULT_CONVENTIONS: JSON.stringify({
      ideaTag: vaultTagLabel(config.vault.ideaTag),
      workingPaperTag: vaultTagLabel(config.vault.workingPaperTag),
      projects: config.vault.projects,
      ...(config.vault.guideUrl ? { guideUrl: config.vault.guideUrl } : {}),
    }),
    STORAGE_CONFIG: JSON.stringify(config.storage),
    PUBLIC_FEED: String(config.instance.publicFeed),
    HEALTH_ON_TIME_BY: config.schedule.onTimeBy,
    INSTANCE_CONFIG: JSON.stringify({
      name: config.instance.name,
      language: config.instance.language,
      timezone: config.instance.timezone,
      topics: config.topics.map((t) => t.name),
      ...(config.agent.mode === "none" ? { keywordOnly: true } : {}),
      ...(topVenues.length ? { topVenues } : {}),
    }),
  };
}

/** The Worker's plain variables for a deployment, on Cloudflare or an own
 * server: the web settings, the instance's top venues and the optional
 * library and Access settings. */
export async function deploymentVars(config: LitScoutConfig, cwd: string) {
  return {
    ...webVars(
      config,
      await topVenueNames(path.resolve(cwd, config.sources.venues.watchlist)),
    ),
    MCP_RESEARCH_TOOLS: String(config.mcp.researchTools),
    ...(config.library.unpaywallEmail
      ? { UNPAYWALL_EMAIL: config.library.unpaywallEmail }
      : {}),
    ...(config.access.teamDomain
      ? { ACCESS_TEAM_DOMAIN: config.access.teamDomain }
      : {}),
    ...(config.access.aud ? { ACCESS_AUD: config.access.aud } : {}),
  };
}
