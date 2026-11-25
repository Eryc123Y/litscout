import { defineConfig, type LitScoutConfig } from "@litscout/core";

const profileDefaults = defineConfig({}).profile;
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * `profile` is accepted so older configs keep validating, but no command reads
 * it. The digest agent's context comes from vault notes and digest brief files;
 * vault.exclude is the only setting that keeps notes out of vault reads.
 */
export function profileWarnings(profile: LitScoutConfig["profile"]) {
  const configured =
    profile.root !== profileDefaults.root ||
    profile.include.length > 0 ||
    Object.keys(profile.kinds).length > 0 ||
    !sameList(profile.exclude, profileDefaults.exclude);
  return configured
    ? [
        "profile is not read by LitScout. The digest agent gets its context from vault notes (vault.projects, vault.ideaTag, vault.briefs) and digest.briefFiles; research.contextBodies decides whether note bodies are sent, and vault.exclude keeps notes out of every vault read. Remove the profile section.",
      ]
    : [];
}
