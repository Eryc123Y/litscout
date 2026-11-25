import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, type ConfigInput } from "@litscout/core";
import { apiAgent, checkApiAgent } from "../src/agent-api";
import type { FlowDeps } from "../src/flow-runtime";

const keyEnv = "FIXTURE_PROVIDER_KEY";
const key = ["fixture", crypto.randomUUID()].join("-");
const openai = "https://api.openai.com/v1/chat/completions";
const anthropic = "https://api.anthropic.com/v1/messages";
const config = (api: NonNullable<NonNullable<ConfigInput["agent"]>["api"]>) =>
  defineConfig({ agent: { api } }).agent.api!;
const defaults = {
  provider: "openai",
  keyEnv,
  maxRequestsPerDay: 10,
  maxTokensPerDay: 10_000,
} as const;

type Reply = (url: string, init?: RequestInit) => Response | Promise<Response>;
const paths: string[] = [];
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-byok-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  paths.length = 0;
});
function fixture(endpoint: string, ...replies: Reply[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const reply = replies.shift();
    if (String(url) !== endpoint || !reply) return globalThis.fetch(url, init);
    paths.push(String(url));
    return reply(String(url), init);
  });
  const clock = { now: "2026-11-18T10:00:00Z" };
  const deps = {
    dir,
    cacheDir: dir,
    fetch,
    env: { [keyEnv]: key },
    flow: { now: () => new Date(clock.now), sleep: vi.fn(async () => {}) },
  } as unknown as FlowDeps;
  return { deps, fetch, clock };
}
const openAiReply = (text: string = "{}") =>
  Response.json({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  });
const run = (
  deps: FlowDeps,
  api = config(defaults),
  prompt = "Return a JSON object",
) => apiAgent(deps, api)(prompt, 24);

it.each(["openai", "anthropic"] as const)(
  "sends the prompt, model, key and output limit through the mocked %s endpoint",
  async (provider) => {
    const model = "custom-model";
    const h = fixture(
      provider === "openai" ? openai : anthropic,
      (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("error");
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model,
          messages: [{ role: "user", content: "Return a JSON object" }],
          [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: 24,
        });
        if (provider === "anthropic") {
          expect(headers.get("x-api-key") === key).toBe(true);
          expect(headers.get("anthropic-version")).toBe("2023-06-01");
          return Response.json({
            content: [{ type: "text", text: "{}" }],
            usage: { input_tokens: 20, output_tokens: 5 },
          });
        }
        expect(headers.get("authorization") === "Bearer " + key).toBe(true);
        return openAiReply();
      },
    );
    await expect(
      run(h.deps, config({ ...defaults, provider, model })),
    ).resolves.toEqual({ code: 0, text: "{}" });
    expect(
      JSON.parse(
        await readFile(path.join(dir, "agent-api-2026-11-18.json"), "utf8"),
      ),
    ).toEqual({ requests: 1, tokens: 25 });
  },
);

it("retries 429 and 5xx within the wait limit and reserves usage for every attempt", async () => {
  const h = fixture(
    openai,
    () => new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
    () =>
      new Response(null, {
        status: 503,
        headers: { "Retry-After": "Wed, 18 Nov 2026 10:00:03 GMT" },
      }),
    () => openAiReply(),
  );
  await expect(run(h.deps)).resolves.toEqual({ code: 0, text: "{}" });
  expect(h.deps.flow?.sleep).toHaveBeenNthCalledWith(1, 2000);
  expect(h.deps.flow?.sleep).toHaveBeenNthCalledWith(2, 3000);
  expect(paths).toHaveLength(3);
  const tally = JSON.parse(
    await readFile(path.join(dir, "agent-api-2026-11-18.json"), "utf8"),
  );
  expect(tally).toMatchObject({ requests: 3 });
  expect(tally.tokens).toBeGreaterThan(25);
});

it("stops before Retry-After would exceed the wait bound and never echoes a provider error", async () => {
  const h = fixture(
    openai,
    () => new Response(key, { status: 429, headers: { "Retry-After": "999" } }),
  );
  const result = await run(h.deps);
  expect(result).toMatchObject({
    code: 1,
    diagnostic: expect.stringContaining("rate limit"),
  });
  expect(JSON.stringify(result).includes(key)).toBe(false);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect(h.deps.flow?.sleep).not.toHaveBeenCalled();
});

it("rejects a missing env variable and never forwards a key echoed in a success body", async () => {
  const h = fixture(openai, () =>
    openAiReply('{"echo":"\\u0066' + key.slice(1) + '"}'),
  );
  const api = config(defaults);
  const missing = { ...h.deps, env: {} };
  expect(checkApiAgent(missing, api)).toMatchObject({
    usable: false,
    reason: expect.stringContaining(keyEnv),
  });
  expect((await run(missing, api)).code).toBe(1);
  expect(h.fetch).not.toHaveBeenCalled();
  const result = await run(h.deps, api);
  expect(result).toMatchObject({
    code: 1,
    diagnostic: expect.stringContaining("quarantined"),
  });
  expect(JSON.stringify(result).includes(key)).toBe(false);
});

it("enforces parallel and subsequent request caps, including retries, and resets by UTC day", async () => {
  const h = fixture(
    openai,
    () => new Response(null, { status: 503 }),
    () => openAiReply(),
  );
  const api = config({ ...defaults, maxRequestsPerDay: 1 });
  const agent = apiAgent(h.deps, api);
  const responses = await Promise.all([agent("{}", 24), agent("{}", 24)]);
  for (const response of responses)
    expect(response).toMatchObject({
      budgetShort: expect.stringMatching(/request/i),
    });
  expect(h.fetch).toHaveBeenCalledTimes(1);
  await expect(run(h.deps, api)).resolves.toHaveProperty("budgetShort");
  h.clock.now = "2026-11-19T00:00:00Z";
  await expect(run(h.deps, api)).resolves.toEqual({ code: 0, text: "{}" });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it("keeps a run cap across midnight, shares token usage and fails closed on a corrupt tally", async () => {
  const h = fixture(openai, () => openAiReply());
  const api = config({
    ...defaults,
    maxRequestsPerRun: 1,
    maxTokensPerDay: 200,
  });
  const agent = apiAgent(h.deps, api);
  expect((await agent("{}", 24)).code).toBe(0);
  await expect(run(h.deps, api, "x".repeat(190))).resolves.toMatchObject({
    budgetShort: expect.stringMatching(/token/i),
  });
  h.clock.now = "2026-11-19T00:00:00Z";
  await expect(agent("{}", 24)).resolves.toMatchObject({
    budgetShort: expect.stringMatching(/run/i),
  });
  await writeFile(path.join(dir, "agent-api-2026-11-19.json"), "{corrupt");
  await expect(run(h.deps, api)).resolves.toMatchObject({
    code: 1,
    diagnostic: expect.stringMatching(/budget/i),
  });
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it("enforces a lower token cap per command and charges exact usage when it fits", async () => {
  const h = fixture(
    openai,
    () => openAiReply(),
    () => openAiReply(),
  );
  const api = config({ ...defaults, maxTokensPerRun: 75 });
  const agent = apiAgent(h.deps, api);
  await expect(agent("{}", 24)).resolves.toEqual({ code: 0, text: "{}" });
  await expect(agent("{}", 24)).resolves.toMatchObject({
    budgetShort: expect.stringMatching(/run token cap/i),
  });
  await expect(apiAgent(h.deps, api)("{}", 24)).resolves.toEqual({
    code: 0,
    text: "{}",
  });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it("does not send a key when runtime configuration no longer trusts the endpoint", async () => {
  const h = fixture("https://gateway.example/v1/chat/completions", () =>
    openAiReply(),
  );
  const api = config(defaults);
  api.baseUrl = "https://gateway.example/v1";
  await expect(run(h.deps, api)).resolves.toMatchObject({ code: 1 });
  expect(h.fetch).not.toHaveBeenCalled();
});

it.each([undefined, { prompt_tokens: 1 }])(
  "warns and keeps the full custom API reservation without valid usage (%#)",
  async (usage) => {
    const baseUrl = "https://gateway.example/v1";
    const h = fixture(baseUrl + "/chat/completions", () =>
      Response.json({ choices: [{ message: { content: "{}" } }], usage }),
    );
    const warn = vi.fn();
    h.deps.flow!.warn = warn;
    const api = config({
      ...defaults,
      baseUrl,
      trustedHosts: ["gateway.example"],
    });
    await expect(run(h.deps, api, "{}")).resolves.toEqual({
      code: 0,
      text: "{}",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/usage.*reservation/i),
    );
    expect(
      JSON.parse(
        await readFile(path.join(dir, "agent-api-2026-11-18.json"), "utf8"),
      ),
    ).toEqual({ requests: 1, tokens: 58 });
    expect(h.fetch).toHaveBeenCalledOnce();
  },
);

it("starts a new daily tally if the local cache directory is deleted", async () => {
  const h = fixture(
    openai,
    () => openAiReply(),
    () => openAiReply(),
  );
  const api = config({ ...defaults, maxRequestsPerDay: 1 });
  await expect(run(h.deps, api)).resolves.toMatchObject({ code: 0 });
  await expect(run(h.deps, api)).resolves.toHaveProperty("budgetShort");
  await rm(dir, { recursive: true, force: true });
  await expect(run(h.deps, api)).resolves.toMatchObject({ code: 0 });
  expect(h.fetch).toHaveBeenCalledTimes(2);
});
