import { expect, it, vi } from "vitest";
import {
  apiOrigin,
  configSchema,
  defineConfig,
  validateConfig,
} from "../src/config";
import { createLogger } from "../src/logger";
import template from "../../../templates/self-host/litscout.config";

it("validates the neutral template and every documented default", () => {
  const config = defineConfig({});
  expect(config.storage.fullDays).toBe(45);
  expect(config.schedule.onTimeBy).toBe("11:30");
  expect(config.digest).toEqual({
    picksPerTopic: 3,
    radarFullTextPerDay: 2,
    suggestionsPerDay: 3,
    ratingsLookbackDays: 28,
    briefFiles: [],
  });
  expect(config.instance).toMatchObject({
    name: "LitScout",
    // Neutral defaults: a new instance names no one's time zone or vault.
    timezone: "UTC",
    language: "en",
    publicFeed: false,
  });
  expect(config.vault.digestsDir).toBe("LitScout/Digests");
  expect(config.sources.huggingface).toEqual({
    dailyPapers: true,
    upvotesDays: 7,
  });
  expect(config.library).not.toHaveProperty("resolveOrder");
  expect(config).not.toHaveProperty("export");
  expect(config.mcp.researchTools).toBe(false);
  expect(configSchema.safeParse(template).success).toBe(true);
  expect(template.instance.publicFeed).toBe(false);
  expect(defineConfig({ instance: {} }).instance.publicFeed).toBe(false);
  expect(
    defineConfig({ instance: { publicFeed: true } }).instance.publicFeed,
  ).toBe(true);
});
it("rejects settings that no command reads", () => {
  // Accepting them silently would suggest they work.
  expect(
    configSchema.safeParse({ export: { ideasDir: "Ideas" } }).success,
  ).toBe(false);
  expect(
    configSchema.safeParse({ library: { resolveOrder: ["crossref"] } }).success,
  ).toBe(false);
});
it("accepts a configured local digest deadline", () => {
  expect(
    defineConfig({ schedule: { onTimeBy: "09:45" } }).schedule.onTimeBy,
  ).toBe("09:45");
  expect(() => defineConfig({ schedule: { onTimeBy: "24:00" } })).toThrow(
    /schedule.onTimeBy/,
  );
});
it("reports all invalid paths together, including unknown fields", () => {
  expect(() =>
    validateConfig({
      storage: { fullDays: -1 },
      instance: { publicUrl: "bad", timezone: "bad-zone" },
      extra: true,
    }),
  ).toThrow(/storage.fullDays/);
  try {
    validateConfig({
      instance: { publicUrl: "bad", timezone: "bad-zone" },
      digest: { picksPerTopic: -1 },
    });
  } catch (error) {
    expect(String(error)).toContain("instance.publicUrl");
    expect(String(error)).toContain("instance.timezone");
    expect(String(error)).toContain("digest.picksPerTopic");
  }
});
it("defaults the browser origin to the CLI origin without overriding an explicit browser host", () => {
  const publicUrl = "https://worker.example";
  const webUrl = "https://reader.example/";
  expect(defineConfig({ instance: { publicUrl } }).instance.webUrl).toBe(
    publicUrl,
  );
  expect(
    defineConfig({ instance: { publicUrl, webUrl } }).instance,
  ).toMatchObject({ publicUrl, webUrl });
  for (const url of [
    "ftp://reader.example",
    "https://reader.example/app",
    "https://reader.example/?query",
    // Built at runtime so the repository audit does not read it as a contact address.
    ["https://name", "reader.example"].join("@"),
  ]) {
    expect(() => defineConfig({ instance: { webUrl: url } })).toThrow(
      /instance.webUrl/,
    );
  }
});
it("accepts all configured fields and preserves the input", () => {
  const input = {
    topics: [{ name: "Vision", keywords: ["stereo"], color: "blue" }],
    profile: {
      root: "./vault",
      include: ["**/*.md"],
      exclude: ["private/**"],
      kinds: { "**/*.md": "project" as const },
    },
    agent: { summaries: { client: "codex" as const } },
  };
  const before = structuredClone(input);
  expect(defineConfig(input).agent.summaries.client).toBe("codex");
  expect(input).toEqual(before);
});
it("writes only messages at or above the chosen log level", () => {
  const sink = vi.fn();
  const logger = createLogger("warn", sink);
  logger.debug("debug");
  logger.info("info");
  logger.warn("warn");
  logger.error("error", { code: 1 });
  expect(sink.mock.calls).toEqual([
    [{ level: "warn", message: "warn" }],
    [{ level: "error", message: "error", context: { code: 1 } }],
  ]);
  const all = createLogger("debug", sink);
  all.debug("visible");
  all.info("visible");
  expect(sink).toHaveBeenCalledTimes(4);
});
it("validates optional Access configuration without accepting URL/path injection", () => {
  expect(defineConfig({}).access).toEqual({});
  expect(
    defineConfig({
      access: {
        teamDomain: "your-team.cloudflareaccess.com",
        aud: "EXAMPLE_AUD",
      },
    }).access,
  ).toEqual({
    teamDomain: "your-team.cloudflareaccess.com",
    aud: "EXAMPLE_AUD",
  });
  expect(
    defineConfig({ access: { teamDomain: "team.example" } }).access.aud,
  ).toBeUndefined();
  for (const teamDomain of [
    "https://team.example",
    "team.example/path",
    "-bad.example",
    "bad..example",
  ]) {
    expect(() => defineConfig({ access: { teamDomain } })).toThrow(
      /access.teamDomain/,
    );
  }
  expect(() => defineConfig({ access: { aud: " " } })).toThrow(/access.aud/);
});

it("does not use a non-HTTPS, credentialed or path-bearing endpoint as the browser fallback", () => {
  for (const publicUrl of [
    "http://localhost:4173",
    "https://worker.example/feed",
    "https://worker.example/%2e%2e",
    "https://worker.example/a/..",
    ["https://user", "worker.example"].join("@"),
  ])
    expect(
      defineConfig({ instance: { publicUrl } }).instance.webUrl,
    ).toBeUndefined();
});

it("accepts only HTTPS or loopback HTTP as the CLI endpoint", () => {
  for (const publicUrl of [
    "http://localhost:4173",
    "http://127.5.6.7:4173",
    "http://[::1]:4173",
    "https://worker.example",
  ])
    expect(defineConfig({ instance: { publicUrl } }).instance.publicUrl).toBe(
      publicUrl,
    );
  for (const publicUrl of [
    "http://worker.example",
    "http://localhost.example",
    "http://[::2]",
    "ftp://localhost",
  ])
    expect(() => defineConfig({ instance: { publicUrl } })).toThrow(
      /instance.publicUrl.*HTTPS/,
    );
});

it("accepts one tag or a list of tags for ideas and working papers", async () => {
  const { vaultTagLabel, vaultTagList } = await import("../src/config");
  expect(defineConfig({}).vault.ideaTag).toBe("type/idea");
  const listed = defineConfig({
    vault: {
      ideaTag: ["type/idea", "#Type/Synthesis", "type/idea"],
      workingPaperTag: "type/working-paper",
    },
  }).vault;
  expect(vaultTagList(listed.ideaTag)).toEqual(["type/idea", "type/synthesis"]);
  expect(vaultTagList(listed.workingPaperTag)).toEqual(["type/working-paper"]);
  expect(vaultTagLabel(listed.ideaTag)).toBe(
    "type/idea, #Type/Synthesis, type/idea",
  );
  for (const ideaTag of [[], [""], "", Array(21).fill("type/idea")])
    expect(() => validateConfig({ vault: { ideaTag } })).toThrow(/ideaTag/);
});

it("rejects a tag listed for both ideas and working papers", () => {
  expect(() =>
    validateConfig({
      vault: {
        ideaTag: ["type/idea", "#Type/Draft"],
        workingPaperTag: "type/draft",
      },
    }),
  ).toThrow(/both vault.ideaTag and vault.workingPaperTag/);
});

it("sends tokens only to HTTPS or the loopback interface", () => {
  expect(apiOrigin("https://api.example.org/path")).toBe(
    "https://api.example.org",
  );
  expect(apiOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  expect(apiOrigin("http://localhost:8787/")).toBe("http://localhost:8787");
  expect(apiOrigin("http://api.example.org")).toBeUndefined();
  expect(apiOrigin("http://127.example.org")).toBeUndefined();
  expect(apiOrigin(undefined)).toBeUndefined();
});
