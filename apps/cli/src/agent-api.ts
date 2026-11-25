import { z } from "zod";
import {
  agentApiSchema,
  type AgentApiConfig,
} from "@litscout/core/agent-config";
import {
  parseAgentJson,
  type AgentAnswer,
  type PreflightResult,
} from "@litscout/pipeline/agent-chain";
import { fetchWithRetry } from "@litscout/sources/http/fetch-retry";
import { apiBudget, ApiBudgetShort } from "./agent-api-budget";
import type { SetupDeps } from "./command-types";
import { NonPublicAddressError, preparePublicJsonPost } from "./public-fetch";

const tokenCount = z.number().int().nonnegative();
const anthropicReply = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
  usage: z
    .object({
      input_tokens: tokenCount,
      output_tokens: tokenCount,
      cache_creation_input_tokens: tokenCount.default(0),
      cache_read_input_tokens: tokenCount.default(0),
    })
    .optional(),
});
const openAiUsage = z.object({
  prompt_tokens: tokenCount,
  completion_tokens: tokenCount,
});
const openAiReply = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullish() }) }))
    .optional(),
  usage: openAiUsage.optional(),
});
const customReply = openAiReply.extend({ usage: z.unknown().optional() });

function providerOutput(config: AgentApiConfig, body: unknown) {
  if (config.provider === "anthropic") {
    const { content, usage } = anthropicReply.safeParse(body).data ?? {};
    return {
      text:
        content
          ?.filter(({ type }) => type === "text")
          .map(({ text }) => text)
          .join("\n") ?? "",
      tokens:
        usage &&
        usage.input_tokens +
          usage.output_tokens +
          usage.cache_creation_input_tokens +
          usage.cache_read_input_tokens,
    };
  }
  const result = (config.baseUrl ? customReply : openAiReply).safeParse(
    body,
  ).data;
  const usage = openAiUsage.safeParse(result?.usage).data;
  return {
    text: result?.choices?.[0]?.message.content ?? "",
    tokens: usage && usage.prompt_tokens + usage.completion_tokens,
  };
}

function apiKey(deps: SetupDeps, config: AgentApiConfig) {
  return (deps.env ?? process.env)[config.keyEnv]?.trim();
}
export function apiHost(config?: AgentApiConfig) {
  if (!config) return {};
  return {
    host:
      config.provider === "anthropic"
        ? "api.anthropic.com"
        : (config.baseUrl && URL.parse(config.baseUrl)?.hostname) ||
          "api.openai.com",
  };
}

export function checkApiAgent(
  deps: SetupDeps,
  config?: AgentApiConfig,
): PreflightResult {
  const reason = !config
    ? "Configure agent.api"
    : !agentApiSchema.safeParse(config).success
      ? "Invalid agent.api configuration; check keyEnv and trustedHosts"
      : !apiKey(deps, config)
        ? `Set the ${config.keyEnv} environment variable`
        : null;
  return { client: "api", usable: reason === null, reason: reason ?? "ready" };
}

const repairInstruction =
  "\n\nThe previous response was invalid. Return a corrected JSON object that matches the schema and includes no other text.";
const inputEstimate = (prompt: string) =>
  Buffer.byteLength(prompt, "utf8") + 32;
export const summaryOutputTokens = (papers: number) =>
  Math.min(32_768, 32 + 512 * papers);
export const digestOutputTokens = 8192;

export function apiPreview(
  day: string,
  config: AgentApiConfig | undefined,
  selected: boolean,
  calls: readonly { prompt: string; outputTokens: number }[],
) {
  if (!config || !selected)
    return {
      status: "dry-run" as const,
      day,
      ...apiHost(config),
      message: "No API client configured in this command's agent chain.",
    };
  const withCost = ({
    inputTokens,
    outputTokens,
  }: {
    inputTokens: number;
    outputTokens: number;
  }) => ({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(config.prices && {
      estimatedCostUsd:
        inputTokens * config.prices.inputPerToken +
        outputTokens * config.prices.outputPerToken,
    }),
  });
  const perCall = calls.map(({ prompt, outputTokens }) =>
    withCost({ inputTokens: inputEstimate(prompt), outputTokens }),
  );
  const total = withCost(
    perCall.reduce(
      (sum, { inputTokens, outputTokens }) => ({
        inputTokens: sum.inputTokens + inputTokens,
        outputTokens: sum.outputTokens + outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
  );
  return {
    status: "dry-run" as const,
    day,
    ...apiHost(config),
    provider: config.provider,
    model: config.model,
    perCall,
    total,
  };
}

const failure = (diagnostic: string): AgentAnswer => ({
  code: 1,
  text: "",
  diagnostic,
});

export function apiAgent(deps: SetupDeps, config?: AgentApiConfig) {
  const budget = config && apiBudget(deps, config);
  return async (
    prompt: string,
    outputTokens: number,
    { timeout = 900, repair = false, live = false } = {},
  ): Promise<AgentAnswer> => {
    const check = checkApiAgent(deps, config);
    if (!config || !budget || !check.usable) return failure(check.reason);
    const key = apiKey(deps, config)!;
    const content = prompt + (repair ? repairInstruction : "");
    const reserved = inputEstimate(content) + outputTokens;
    const isAnthropic = config.provider === "anthropic";
    const endpoint = isAnthropic
      ? "https://api.anthropic.com/v1/messages"
      : new URL(config.baseUrl ?? "https://api.openai.com/v1").href.replace(
          /\/+$/,
          "",
        ) + "/chat/completions";
    const body = {
      model: config.model,
      messages: [{ role: "user", content }],
      [isAnthropic || config.baseUrl ? "max_tokens" : "max_completion_tokens"]:
        outputTokens,
    };
    let reservation: Awaited<ReturnType<typeof budget.reserve>> | undefined;
    let post: typeof fetch | undefined;
    const usePinnedPost = config.baseUrl && deps.fetch === globalThis.fetch;
    let budgetFailed = false;
    try {
      const response = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            ...(isAnthropic
              ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
              : { authorization: "Bearer " + key }),
          },
          body: JSON.stringify(body),
        },
        {
          fetchImpl: usePinnedPost
            ? (url, init) => post!(url, init)
            : deps.fetch,
          retries: live ? 0 : 2,
          timeoutMs: timeout * 1000,
          baseDelayMs: 1000,
          maxDelayMs: 15_000,
          sleep: deps.flow?.sleep,
          now: () => (deps.flow?.now?.() ?? new Date()).getTime(),
          beforeAttempt: async () => {
            try {
              reservation = await budget.reserve(reserved);
            } catch (error) {
              budgetFailed = true;
              throw error;
            }
            if (usePinnedPost) post ??= await preparePublicJsonPost(endpoint);
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const { status } = response;
        return failure(
          status === 429
            ? "API rate limit reached"
            : status === 401 || status === 403
              ? "Unauthorized API request"
              : status >= 500
                ? "Cannot start client: API provider unavailable"
                : `API request rejected (HTTP ${status})`,
        );
      }
      const { text, tokens } = providerOutput(
        config,
        await response.json().catch(() => null),
      );
      if (tokens !== undefined && reservation) {
        try {
          await budget.settle(reservation, tokens);
        } catch {
          return failure("Cannot update the local API budget");
        }
      } else if (config.baseUrl && tokens === undefined) {
        (deps.flow?.warn ?? console.error)(
          "Custom API response has no valid usage; charged the full token reservation.",
        );
      }
      // Error bodies never leave this module. Reject exact credential echoes in
      // both plain text and JSON strings where the key may have been escaped.
      const decoded = parseAgentJson(text);
      if (
        text.includes(key) ||
        (decoded !== null &&
          JSON.stringify(decoded).includes(JSON.stringify(key).slice(1, -1)))
      )
        return failure("API output quarantined");
      return { code: 0, text };
    } catch (error) {
      if (error instanceof NonPublicAddressError)
        return failure(
          "Custom API host must resolve only to public HTTPS addresses",
        );
      if (error instanceof ApiBudgetShort)
        return { ...failure("API budget short"), budgetShort: error.message };
      return failure(
        budgetFailed
          ? "Cannot read or update the local API budget"
          : "Cannot start client: API request failed",
      );
    }
  };
}

export async function liveApiCheck(
  deps: SetupDeps,
  config?: AgentApiConfig,
): Promise<PreflightResult> {
  const check = checkApiAgent(deps, config);
  if (!check.usable) return check;
  const result = await apiAgent(deps, config)(
    'Reply with the single JSON object {"ok":true}.',
    16,
    { timeout: 20, live: true },
  );
  return result.code === 0 && result.text.trim()
    ? { client: "api", usable: true, reason: "live check passed" }
    : {
        client: "api",
        usable: false,
        reason: result.budgetShort ?? result.diagnostic ?? "Empty API response",
      };
}
