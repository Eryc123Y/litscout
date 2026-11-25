import { expect, it } from "vitest";
import { defineConfig } from "@litscout/core";
import { webVars } from "../src/web-vars";
it("publishes only safe instance display settings and the explicit public switch", () => {
  const config = defineConfig({
    instance: {
      publicFeed: false,
      name: "Reader",
      language: "zh",
      timezone: "Asia/Shanghai",
    },
    schedule: { onTimeBy: "09:45" },
    vault: {
      root: "Private/Local vault",
      name: "Reader’s vault",
      ideaTag: "lab/idea",
      workingPaperTag: "lab/draft",
      projects: ["Projects/*.md"],
      exclude: ["Private exclusion.md"],
    },
    topics: [{ name: "Vision", keywords: ["PRIVATE_KEYWORD"] }],
  });
  const vars = webVars(config);
  expect(vars.VAULT_NAME).toBe("Reader’s vault");
  expect(JSON.parse(vars.VAULT_CONVENTIONS)).toEqual({
    ideaTag: "lab/idea",
    workingPaperTag: "lab/draft",
    projects: ["Projects/*.md"],
  });
  expect(JSON.stringify(vars)).not.toContain("Private exclusion.md");
  expect(vars.INSTANCE_CONFIG).not.toContain("vault");
  expect(JSON.stringify(vars)).not.toContain("Private/Local vault");
  expect(vars.PUBLIC_FEED).toBe("false");
  expect(vars.HEALTH_ON_TIME_BY).toBe("09:45");
  expect(JSON.parse(vars.INSTANCE_CONFIG)).toEqual({
    name: "Reader",
    language: "zh",
    timezone: "Asia/Shanghai",
    topics: ["Vision"],
  });
  expect(JSON.stringify(vars)).not.toContain("PRIVATE_KEYWORD");
});

it("publishes a tag list as one display label", () => {
  const config = defineConfig({
    vault: {
      ideaTag: ["type/idea", "type/synthesis"],
      workingPaperTag: ["type/working-paper"],
    },
  });
  expect(JSON.parse(webVars(config).VAULT_CONVENTIONS)).toMatchObject({
    ideaTag: "type/idea, type/synthesis",
    workingPaperTag: "type/working-paper",
  });
});

it("passes the vault conventions guide URL from the config, and nothing when unset (R4)", () => {
  const guideUrl = "https://docs.example/self-host.md#vault-conventions";
  expect(
    JSON.parse(
      webVars(defineConfig({ vault: { guideUrl } })).VAULT_CONVENTIONS,
    ),
  ).toMatchObject({ guideUrl });
  expect(
    JSON.parse(webVars(defineConfig({})).VAULT_CONVENTIONS),
  ).not.toHaveProperty("guideUrl");
  expect(() =>
    defineConfig({ vault: { guideUrl: "javascript:alert(1)" } }),
  ).toThrow();
});
