import { expect, it } from "vitest";
import { defineConfig, validateConfig } from "../src/config";

const api = {
  provider: "openai",
  keyEnv: "FIXTURE_PROVIDER_KEY",
  maxRequestsPerDay: 10,
  maxTokensPerDay: 20_000,
} as const;

it("keeps API spending opt-in and supplies provider-specific model defaults", () => {
  const defaults = defineConfig({}).agent;
  expect(defaults.api).toBeUndefined();
  expect(defaults.summaries.fallback).not.toContain("api");
  expect(defaults.digest.fallback).not.toContain("api");
  const configured = defineConfig({
    agent: { api, summaries: { fallback: ["codex", "api"] } },
  }).agent;
  expect(configured.summaries.fallback).toEqual(["codex", "api"]);
  expect(configured.api?.model).toBe("gpt-4.1-mini");
  expect(
    defineConfig({ agent: { api: { ...api, provider: "anthropic" } } }).agent
      .api?.model,
  ).toBe("claude-haiku-4-5");
});

it("validates env-var names, models, prices, HTTPS endpoints and caps without accepting a key", () => {
  expect(
    defineConfig({
      agent: {
        api: {
          ...api,
          model: "vendor/model-v1.2",
          baseUrl: "https://gateway.example/v1",
          trustedHosts: ["gateway.example"],
          maxTokensPerRun: 8000,
          prices: { inputPerToken: 0, outputPerToken: 0.000001 },
        },
      },
    }).agent.api?.model,
  ).toBe("vendor/model-v1.2");
  for (const invalid of [
    { key: ["fixture", "secret"].join("-") },
    { keyEnv: "not a name" },
    { model: "--model" },
    { maxRequestsPerDay: -1 },
    { maxTokensPerDay: 2.5 },
    { maxTokensPerRun: 20_001 },
    { prices: { inputPerToken: -1, outputPerToken: 0 } },
    { baseUrl: "http://gateway.example" },
    { baseUrl: "https://user" + "@host.example/v1" },
    { baseUrl: "https://host.example/v1?key=value" },
    { provider: "anthropic", baseUrl: "https://host.example" },
  ])
    expect(() =>
      validateConfig({ agent: { api: { ...api, ...invalid } } }),
    ).toThrow("agent.api");
});

it.each(["OPENAI_API_KEY", "PROVIDER_KEY"])(
  "accepts provider key names (%s)",
  (keyEnv) => {
    expect(
      defineConfig({ agent: { api: { ...api, keyEnv } } }).agent.api?.keyEnv,
    ).toBe(keyEnv);
  },
);

it.each([
  "DATABASE_PASSWORD",
  "API_KEY_BACKUP",
  ...[
    "LITSCOUT",
    "CLOUDFLARE",
    "CF",
    "AWS",
    "GITHUB",
    "GH",
    "GOOGLE",
    "AZURE",
    "NPM",
    "aws",
  ].map((prefix) => prefix + "_FIXTURE_API_KEY"),
])("rejects an unsafe key variable name (%s)", (keyEnv) => {
  expect(() => validateConfig({ agent: { api: { ...api, keyEnv } } })).toThrow(
    "agent.api.keyEnv",
  );
});

it.each([
  "127.0.0.1",
  "0x7f000001",
  "10.0.0.1",
  "8.8.8.8",
  "[::1]",
  "[2606:4700:4700::1111]",
  "localhost",
  "localhost.",
  "printer.local.",
  "api.localhost",
])("rejects a custom base URL with a forbidden host (%s)", (host) => {
  expect(() =>
    validateConfig({
      agent: {
        api: {
          ...api,
          baseUrl: "https://" + host,
        },
      },
    }),
  ).toThrow("agent.api.baseUrl");
});

it.each([[], ["parent.example"], ["gateway.parent.example.evil.example"]])(
  "requires the exact configured hostname to be trusted (%j)",
  (...hosts) => {
    expect(() =>
      validateConfig({
        agent: {
          api: {
            ...api,
            baseUrl: "https://gateway.parent.example/v1",
            trustedHosts: hosts,
          },
        },
      }),
    ).toThrow();
  },
);
