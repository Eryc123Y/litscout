import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineConfig, type ConfigInput } from "@litscout/core";
import { digestCommand } from "../src/digest-command";
import { doctorCommand } from "../src/doctor-command";
import { summaryCommand } from "../src/summary-command";
import { parseCommand } from "../src/setup-commands";
import type { FlowDeps } from "../src/flow-runtime";
import { doctorResponse } from "./helpers/doctor";

const day = "2026-11-18";
const keyEnv = "FIXTURE_PROVIDER_KEY";
const key = ["fixture", crypto.randomUUID()].join("-");
const completions = "https://gateway.example/v1/chat/completions";
const worker = "https://worker.example";
const content = {
  tldr: "A finding",
  motivation: "A gap",
  method: "A technique",
  result: "A result",
  conclusion: "A takeaway",
};
const paper = {
  paperId: "pap_one",
  title: "Fixture title",
  abstract: "Fixture abstract",
  source: "arxiv",
  shortlisted: true,
  authors: [],
  links: [],
  topics: [],
  identifiers: [],
  summaries: [{ paperId: "pap_one", lang: "en", content }],
};
const counts = {
  total: 1,
  summarised: 0,
  shortlisted: 0,
  arxiv: 1,
  venues: 0,
  topics: {},
  sources: { arxiv: 1 },
  venueCounts: {},
};
const config = (
  overrides: Partial<
    NonNullable<NonNullable<ConfigInput["agent"]>["api"]>
  > = {},
) =>
  defineConfig({
    instance: { publicUrl: worker },
    agent: {
      summaries: { client: "api", fallback: [], chunkSize: 1 },
      digest: { client: "api", fallback: [] },
      api: {
        provider: "openai",
        baseUrl: "https://gateway.example/v1/",
        trustedHosts: ["gateway.example"],
        keyEnv,
        maxRequestsPerDay: 10,
        maxTokensPerDay: 100_000,
        ...overrides,
      },
    },
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-byok-flow-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
function fixture(...outputs: string[]) {
  const provider = vi.fn((init?: RequestInit) => {
    const text = outputs.shift();
    if (text === undefined) return globalThis.fetch(completions, init);
    expect(
      new Headers(init?.headers).get("authorization") === "Bearer " + key,
    ).toBe(true);
    return Response.json({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === completions) return provider(init);
    if (new URL(String(input)).origin === worker) return doctorResponse(input);
    return globalThis.fetch(input, init);
  };
  let uploaded = false;
  const api = {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route.includes("summary-todo"))
        return {
          day,
          status: "crawled",
          counts,
          noAbstract: 0,
          nextCursor: null,
          items: uploaded ? [] : [paper],
        };
      if (route.startsWith("/feed/days/"))
        return { day, status: "summarised", counts, items: [paper] };
      if (route.startsWith("/operations"))
        return { ratings: [], radar: [], missed: [], runs: [] };
      if (route.startsWith("/digests/")) return null;
      throw new Error("Unexpected fixture route");
    }),
    write: vi.fn(async (route: string, _value: unknown) => {
      if (route === "/ingest/summaries") {
        uploaded = true;
        return { accepted: 1 };
      }
      return {};
    }),
  };
  const deps = {
    dir,
    cwd: dir,
    cacheDir: dir,
    fetch,
    env: { [keyEnv]: key },
    run: vi.fn(async ([command]) =>
      command === "--version" ? "4.151.0" : "Not logged in",
    ),
    flow: { now: () => new Date(day), token: "fixture" },
  } as unknown as FlowDeps;
  return { api, deps, provider };
}
const args = ["run", "--day", day];

it("falls back to API summaries, performs one schema repair and attributes the upload to the configured API model", async () => {
  const h = fixture(
    '{"pap_one":{"tldr":"Incomplete"}}',
    JSON.stringify({ pap_one: content }),
  );
  const cfg = config({ model: "vendor/custom-model" });
  cfg.agent.summaries.client = "codex";
  cfg.agent.summaries.fallback = ["api"];
  h.deps.flow!.preflight = async (client) => ({
    client,
    usable: true,
    reason: "fixture",
  });
  h.deps.flow!.agent = async () => ({ code: 1, text: "OAuth session expired" });
  await expect(summaryCommand(args, h.api, h.deps, cfg)).resolves.toMatchObject(
    {
      status: "done",
      clientsUsed: ["codex", "api"],
      fallback: [{ from: "codex", to: "api", reason: "authentication" }],
    },
  );
  expect(h.provider).toHaveBeenCalledTimes(2);
  const [initial, retry] = h.provider.mock.calls.map(([init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(initial).toMatchObject({
    model: "vendor/custom-model",
    max_tokens: expect.any(Number),
  });
  expect(initial.messages[0].content).toContain("Fixture abstract");
  expect(retry.messages[0].content).toMatch(/previous.*invalid/i);
  expect(h.api.write).toHaveBeenCalledWith(
    "/ingest/summaries",
    expect.objectContaining({
      summaries: [
        expect.objectContaining({
          paperId: "pap_one",
          content,
          client: "api",
          model: "vendor/custom-model",
        }),
      ],
    }),
    100,
  );
});

it("asks the API for TeX formulas only when summaries are set to tex", async () => {
  for (const math of ["plain", "tex"] as const) {
    const h = fixture(JSON.stringify({ pap_one: content }));
    const cfg = config();
    cfg.agent.summaries.math = math;
    await expect(
      summaryCommand(args, h.api, h.deps, cfg),
    ).resolves.toMatchObject({ status: "done" });
    const [request] = h.provider.mock.calls.map(([init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(request.messages[0].content.includes("inline TeX"), math).toBe(
      math === "tex",
    );
  }
  expect(config().agent.summaries.math).toBe("plain");
});

it("repairs malformed digest JSON once, then uploads through the usual digest path", async () => {
  const h = fixture(
    "{malformed",
    JSON.stringify({ day, other: [{ paperId: "pap_one", gist: "Picked" }] }),
  );
  await expect(
    digestCommand(args, h.api, h.deps, config()),
  ).resolves.toMatchObject({
    status: "written",
    clientsUsed: ["api"],
  });
  expect(h.provider).toHaveBeenCalledTimes(2);
  expect(h.api.write).toHaveBeenCalledWith(
    "/digests/" + day,
    expect.objectContaining({ bodyMd: expect.stringContaining("Picked") }),
    20,
    "PUT",
  );
});

it("shares the daily request budget between summary and digest commands", async () => {
  const h = fixture(JSON.stringify({ pap_one: content }));
  const cfg = config({ maxRequestsPerDay: 1 });
  await expect(summaryCommand(args, h.api, h.deps, cfg)).resolves.toMatchObject(
    {
      status: "done",
    },
  );
  await expect(digestCommand(args, h.api, h.deps, cfg)).resolves.toMatchObject({
    status: "budget-short",
    message: expect.stringMatching(/daily request cap/i),
  });
  expect(h.provider).toHaveBeenCalledTimes(1);
});

it.each([summaryCommand, digestCommand])(
  "reports invalid output after one repair and uploads no content (%#)",
  async (command) => {
    const h = fixture("not JSON: OAuth session expired", "[]");
    await expect(command(args, h.api, h.deps, config())).resolves.toMatchObject(
      { status: "error" },
    );
    expect(h.provider).toHaveBeenCalledTimes(2);
    expect(h.api.write.mock.calls.map(([route]) => route)).not.toContain(
      "/ingest/summaries",
    );
    expect(h.api.write.mock.calls.map(([route]) => route)).not.toContain(
      "/digests/" + day,
    );
  },
);

it.each([summaryCommand, digestCommand])(
  "stops cleanly at the token cap without switching to another agent (%#)",
  async (command) => {
    const h = fixture();
    const cfg = config({ maxTokensPerDay: 5 });
    cfg.agent.summaries.fallback = ["codex"];
    cfg.agent.digest.fallback = ["codex"];
    const agent = vi.fn();
    h.deps.flow!.agent = agent;
    h.deps.flow!.preflight = async (client) => ({
      client,
      usable: true,
      reason: "fixture",
    });
    await expect(command(args, h.api, h.deps, cfg)).resolves.toMatchObject({
      status: "budget-short",
      message: expect.stringMatching(/token/i),
      clientsUsed: ["api"],
    });
    expect(h.provider).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  },
);

it.each([summaryCommand, digestCommand])(
  "estimates the actual prompt and priced output without spending or writing (%#)",
  async (command) => {
    const h = fixture();
    const run = () =>
      command(
        [...args, "--dry-run"],
        h.api,
        h.deps,
        config({
          prices: { inputPerToken: 0.001, outputPerToken: 0.002 },
        }),
      );
    const preview = await run();
    expect(preview).toMatchObject({
      status: "dry-run",
      day,
      provider: "openai",
      host: "gateway.example",
      perCall: [
        {
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          estimatedCostUsd: expect.any(Number),
        },
      ],
      total: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number),
      },
    });
    if (!("perCall" in preview) || preview.perCall?.length !== 1)
      throw new Error("Expected a one-call estimate");
    const call = preview.perCall[0]!;
    expect(preview.total).toMatchObject(call);
    expect(call.estimatedCostUsd).toBeCloseTo(
      call.inputTokens * 0.001 + call.outputTokens * 0.002,
    );
    expect(h.provider).not.toHaveBeenCalled();
    expect(h.api.write).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  },
);

it("checks API configuration in doctor without spending or printing the key", async () => {
  const h = fixture();
  const check = () => doctorCommand(h.deps, config(), "fixture");
  const present = await check();
  expect(present.data.agentChecks).toContainEqual(
    expect.objectContaining({
      client: "api",
      usable: true,
      host: "gateway.example",
    }),
  );
  expect(JSON.stringify(present).includes(key)).toBe(false);
  const absent = await doctorCommand(
    { ...h.deps, env: {} },
    config(),
    "fixture",
  );
  expect(absent.data.agentChecks).toContainEqual(
    expect.objectContaining({
      client: "api",
      usable: false,
      reason: expect.stringContaining(keyEnv),
    }),
  );
  expect(h.provider).not.toHaveBeenCalled();
  expect(() => parseCommand(["doctor", "--live"])).not.toThrow();
  expect(() => parseCommand(["doctor", "--live", "--live"])).toThrow();
});
