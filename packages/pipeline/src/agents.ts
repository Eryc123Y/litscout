import { z } from "zod";
import {
  parseBlocks,
  type FivePart,
  type SummaryMath,
  type SummaryPaper,
} from "./blocks";
import { agentModelSchema, commandValues } from "@litscout/core";
import { secretOutsideInput } from "./output-safety";
export {
  parseBlocks,
  formatChunk,
  instructions,
  subagentInstructions,
} from "./blocks";
import type { Client } from "@litscout/core/agent-config";
import {
  ClientChain,
  defaultModel,
  exitCause,
  failedAttemptReason,
  parseAgentJson,
  type AgentAnswer,
  type PreflightResult,
  type WriterOptions,
} from "./agent-chain";
import { fivePartSchema } from "./contracts/index";
export const summaryJsonSchema = z.record(z.string(), fivePartSchema);
export type { Client } from "@litscout/core/agent-config";
export const ANTIGRAVITY_SETTINGS = JSON.stringify({
  agentMode: "",
  toolPermission: "strict",
  enableTerminalSandbox: true,
  allowNonWorkspaceAccess: false,
  permissions: {
    deny: [
      "command(*)",
      "unsandboxed(*)",
      "mcp(*)",
      "read_url(*)",
      "execute_url(*)",
      "read_file(/)",
      "write_file(/)",
    ],
  },
});
export function clientArgv(
  client: Client,
  prompt: string,
  model?: string,
  command?: readonly string[],
  timeout = 900,
) {
  if (client === "api") return [];
  if (model !== undefined) agentModelSchema.parse(model);
  if (command) {
    return restrictCommand(
      client,
      commandValues(command, prompt, model),
      timeout,
    );
  }
  // Claude Code and Antigravity read the prompt on stdin (executeAgent):
  // Linux caps one argument at 128 KB, and a digest prompt is about 1 MB.
  if (client === "claude")
    return [
      "claude",
      "-p",
      "--model",
      model ?? "haiku",
      "--tools",
      "",
      "--strict-mcp-config",
      // Each attempt would otherwise leave its whole prompt in ~/.claude/projects.
      "--no-session-persistence",
    ];
  if (client === "codex")
    return [
      "codex",
      "exec",
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="medium"',
      "-o",
      "{answerFile}",
      ...(model ? ["-m", model] : []),
      "-",
    ];
  if (client === "antigravity")
    return [
      "agy",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--settings",
      ANTIGRAVITY_SETTINGS,
      "--sandbox",
      "--disable-slash-commands",
      "--print-timeout",
      `${timeout - 60}s`,
      "--model",
      model ?? "gemini-4-hydrogen-medium",
      // Print mode with the prompt taken from the stream on stdin.
      "-p=",
    ];
  if (client === "gemini")
    return [
      "gemini",
      "--sandbox",
      "--approval-mode",
      "plan",
      "-p",
      prompt,
      ...(model ? ["--model", model] : []),
    ];
  throw new Error("cmd needs a configured command array with {prompt}");
}
/**
 * The digest writer's argv. Built-in Claude Code answers in its JSON envelope
 * with the draft checked against `schema` (`structured_output`): in plain text
 * it echoed the schema or added notes on a full-size day (2026-11-22).
 */
export function digestArgv(
  client: Client,
  prompt: string,
  model: string | undefined,
  command: readonly string[] | undefined,
  timeout: number | undefined,
  schema: string,
) {
  const argv = clientArgv(client, prompt, model, command, timeout);
  return client === "claude" && !command
    ? [...argv, "--output-format", "json", "--json-schema", schema]
    : argv;
}
function restrictCommand(client: Client, args: string[], timeout: number) {
  if (client === "cmd") return args;
  const forbidden =
    client === "claude"
      ? [
          "--tools",
          "--allowedTools",
          "--allowed-tools",
          "--dangerously-skip-permissions",
          "--mcp-config",
        ]
      : client === "codex"
        ? [
            "--sandbox",
            "-s",
            "--full-auto",
            "-c",
            "--config",
            "--dangerously-bypass-approvals-and-sandbox",
          ]
        : client === "antigravity"
          ? [
              "--settings",
              "--mode",
              "--sandbox",
              "--dangerously-skip-permissions",
              "--add-dir",
              "--print-timeout",
            ]
          : ["--sandbox", "-s", "--approval-mode", "--yolo", "-y"];
  if (
    args.some(
      (arg) =>
        forbidden.includes(arg.split("=")[0]!) ||
        (client === "codex" && /^-[cs].+/.test(arg)),
    )
  )
    throw new Error(
      "Configured client command must leave tool and sandbox restrictions to LitScout",
    );
  const required =
    client === "claude"
      ? ["--tools", "", "--strict-mcp-config", "--no-session-persistence"]
      : client === "codex"
        ? [
            "--ignore-user-config",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-c",
            'model_reasoning_effort="medium"',
            "-o",
            "{answerFile}",
          ]
        : client === "antigravity"
          ? [
              "--settings",
              ANTIGRAVITY_SETTINGS,
              "--sandbox",
              "--disable-slash-commands",
              "--print-timeout",
              `${timeout - 60}s`,
            ]
          : ["--sandbox", "--approval-mode", "plan"];
  return [...args, ...required];
}
export const chunkPrompt = (
  instructions: string,
  input: string,
  output: string,
) =>
  `Read ${instructions} and follow it exactly. Input file: ${input}. Output file: ${output}. Only read the instructions and the input file and write the output file; do not edit anything else. If you have no file tools, use shell commands only to read those two files and to write the output file.`;
export type AgentOptions = WriterOptions & {
  apiModel?: string;
  lang: "en" | "zh";
  math?: SummaryMath;
  parallel: number;
  maxChunks: number;
  model?: string;
  command?: readonly string[];
};
export type AgentDeps = {
  run: (
    argv: string[],
    papers: readonly SummaryPaper[],
    index: number,
    attempt: number,
    context?: WriterOptions,
  ) => Promise<AgentAnswer>;
  upload: (
    summaries: {
      paperId: string;
      lang: "en" | "zh";
      content: FivePart;
      client: Client;
      model?: string;
    }[],
  ) => Promise<void>;
  preflight?: (client: Client) => Promise<PreflightResult>;
  usage: () => Promise<{ fiveHour: number; weekly: number } | null>;
};
async function oneChunk(
  papers: readonly SummaryPaper[],
  index: number,
  options: AgentOptions,
  deps: AgentDeps,
) {
  const found: Record<string, FivePart> = {};
  let reason: string | null = null,
    failure: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A retry asks only for what the first answer left out: a cut-off answer
    // would stop at the same place again.
    const asked = papers.filter((p) => !found[p.paperId]);
    const answer: AgentAnswer = await deps
      .run(
        clientArgv(
          options.client,
          "{chunkPrompt}",
          options.model,
          options.command,
          options.timeout,
        ),
        asked,
        index,
        attempt,
        options,
      )
      .catch(() => ({ code: 1, text: "Cannot start client" }));
    // The whole chunk is input: a retry may quote a paper found earlier.
    if (secretOutsideInput(answer.text, papers))
      return {
        quarantined: true,
        failure: `chunk ${index}: quarantined output`,
        reason: null,
        remaining: [],
      };
    if (answer.budgetShort)
      return { budgetShort: answer.budgetShort, remaining: papers };
    const parsed =
      options.client === "api"
        ? apiSummaries(answer.text, asked)
        : parseBlocks(answer.text).summaries;
    reason = failedAttemptReason(
      answer,
      papers.some((p) => Boolean(parsed[p.paperId])),
      options.client === "api",
    );
    if (reason) break;
    if (answer.code !== 0) {
      const diagnostic =
        options.client === "api" ? answer.diagnostic : undefined;
      failure = `chunk ${index}: ${diagnostic ?? (answer.timedOut ? "agent timed out" : `client exited ${answer.code}${exitCause(answer)}`)}`;
      break;
    }
    for (const p of papers)
      if (!found[p.paperId] && parsed[p.paperId])
        found[p.paperId] = parsed[p.paperId]!;
    if (papers.every((p) => found[p.paperId])) break;
  }
  if (Object.keys(found).length)
    await deps.upload(
      Object.entries(found).map(([paperId, content]) => ({
        paperId,
        content,
        lang: options.lang,
        client: options.client,
        model:
          options.client === "api"
            ? options.apiModel
            : (options.model ?? defaultModel(options.client)),
      })),
    );
  const remaining = papers.filter((p) => !found[p.paperId]);
  return {
    quarantined: false,
    reason,
    remaining,
    // The client answered but left papers out even after a retry.
    incomplete: !failure && !reason && remaining.length > 0,
    failure:
      failure ??
      (!reason && remaining.length
        ? options.client === "api"
          ? `chunk ${index}: invalid summary JSON after a retry`
          : `chunk ${index}: ${Object.keys(found).length} of ${papers.length} complete after a retry`
        : null),
  };
}
function apiSummaries(text: string, papers: readonly SummaryPaper[]) {
  const result = summaryJsonSchema.safeParse(parseAgentJson(text));
  return result.success &&
    Object.keys(result.data).length === papers.length &&
    papers.every(({ paperId }) => Object.hasOwn(result.data, paperId))
    ? result.data
    : {};
}
type Leftover = {
  index: number;
  papers: SummaryPaper[];
  failure: string;
  origin: Client;
};
/** A second pass by the same client uses chunks this small. */
const smallerChunkSize = 10;

const gated = async (rescuer: WriterOptions, deps: AgentDeps) => {
  if (rescuer.client !== "claude") return false;
  const usage = await deps.usage();
  return Boolean(usage && Math.max(usage.fiveHour, usage.weekly) >= 80);
};

/**
 * One rescue pass over a client's leftovers, at most `limit` chunks, with
 * claude's usage gate checked before every batch. Each chunk's failure is
 * kept once if any of its papers are still missing or were not tried.
 */
async function rescueGroup(
  group: readonly Leftover[],
  rescuer: WriterOptions,
  same: boolean,
  options: AgentOptions,
  deps: AgentDeps,
  limit: number,
) {
  const work = same
    ? group.flatMap((leftover) =>
        Array.from(
          { length: Math.ceil(leftover.papers.length / smallerChunkSize) },
          (_, i) => ({
            ...leftover,
            papers: leftover.papers.slice(
              i * smallerChunkSize,
              (i + 1) * smallerChunkSize,
            ),
          }),
        ),
      )
    : group;
  const failed = new Map<number, string>();
  const quarantined: number[] = [];
  const keepUntried = (from: number) => {
    for (const c of work.slice(from))
      if (!failed.has(c.index)) failed.set(c.index, c.failure);
  };
  const runnable = Math.min(work.length, limit);
  let ran = 0;
  while (ran < runnable && !(await gated(rescuer, deps))) {
    const batch = work.slice(ran, Math.min(runnable, ran + options.parallel));
    const results = await Promise.all(
      batch.map((c) =>
        oneChunk(c.papers, c.index, { ...options, ...rescuer }, deps),
      ),
    );
    batch.forEach((c, i) => {
      const r = results[i]!;
      if ("quarantined" in r && r.quarantined) {
        if (!quarantined.includes(c.index)) quarantined.push(c.index);
        failed.set(c.index, r.failure ?? c.failure);
      }
      // The chunk's own count stays the reader's reference.
      else if (r.remaining.length && !failed.has(c.index))
        failed.set(c.index, c.failure);
    });
    ran += batch.length;
    const budget = results.find((r) => r.budgetShort)?.budgetShort;
    if (budget) {
      keepUntried(ran);
      return { failed, quarantined, budget, ran };
    }
  }
  keepUntried(ran);
  return { failed, quarantined, ran };
}
export async function runSummaries(
  chunks: readonly SummaryPaper[][],
  options: AgentOptions,
  deps: AgentDeps,
) {
  z.number().int().min(1).max(8).parse(options.parallel);
  z.number().int().nonnegative().parse(options.maxChunks);
  const chain = new ClientChain(options),
    failures: string[] = [],
    quarantined: number[] = [],
    started = new Set<number>();
  if (!(await chain.check(deps.preflight)))
    return {
      ran: 0,
      failures,
      quarantined,
      stopped: "No usable agent client; check login, installation or quota",
      smallerChunks: 0,
      ...chain.report(),
    };
  let pending = chunks.map((papers, index) => ({ papers, index })),
    stopped: string | null = null;
  const leftovers: Leftover[] = [];
  // Chunks the same client ran again, smaller, for its own leftovers.
  let smallerChunks = 0;
  // Failures of incomplete chunks that no rescue will see.
  const keepLeftovers = (from = 0) =>
    failures.push(...leftovers.slice(from).map((l) => l.failure));
  while (pending.length) {
    const current = { ...options, ...chain.current() };
    if (current.client === "claude") {
      const usage = await deps.usage();
      if (usage && Math.max(usage.fiveHour, usage.weekly) >= 80) {
        stopped = "usage gate";
        break;
      }
    }
    const batch: typeof pending = [];
    while (pending.length && batch.length < options.parallel) {
      if (!started.has(pending[0]!.index) && started.size >= options.maxChunks)
        break;
      const chunk = pending.shift()!;
      started.add(chunk.index);
      batch.push(chunk);
    }
    if (!batch.length) {
      stopped = "chunk budget";
      break;
    }
    chain.used();
    const results = await Promise.all(
      batch.map((c) => oneChunk(c.papers, c.index, current, deps)),
    );
    const retry: typeof pending = [];
    results.forEach((r, i) => {
      if ("incomplete" in r && r.incomplete)
        leftovers.push({
          index: batch[i]!.index,
          papers: r.remaining,
          failure: r.failure!,
          origin: current.client,
        });
      else if (r.failure) failures.push(r.failure);
      if (r.quarantined) quarantined.push(batch[i]!.index);
      if (r.reason && r.remaining.length)
        retry.push({ index: batch[i]!.index, papers: r.remaining });
    });
    const budget = results.find((r) => r.budgetShort)?.budgetShort;
    if (budget) {
      keepLeftovers();
      return {
        ran: started.size,
        failures,
        stopped: "budget-short",
        message: budget,
        quarantined,
        smallerChunks,
        ...chain.report(),
      };
    }
    const reason = results.find((r) => r.reason)?.reason;
    if (reason) {
      if (!chain.advance(reason)) {
        stopped = reason;
        break;
      }
      pending = [...retry, ...pending];
    }
  }
  // Papers a client left out even after a retry get one more pass, so a day
  // is not held back by a few incomplete answers: with the next client, or,
  // when no other client can take them, with the same client in smaller
  // chunks. Only when the run was not stopped: the usage gate and the chunk
  // budget mean "no more agent calls now", and an unusable chain has no
  // client to rescue with.
  if (stopped !== null) keepLeftovers();
  else
    for (let start = 0; start < leftovers.length;) {
      const head = leftovers[start]!;
      const rescuer =
        chain.rescueFor(head.origin) ?? chain.retryFor(head.origin);
      // Leftovers from the same client share a rescuer; take them together.
      let end = start;
      while (end < leftovers.length && leftovers[end]!.origin === head.origin)
        end++;
      const group = leftovers.slice(start, end);
      if (!rescuer) {
        failures.push(...group.map((l) => l.failure));
        start = end;
        continue;
      }
      const same = rescuer.client === head.origin;
      // A second pass by the same client spends the run's chunk budget.
      const limit = same
        ? Math.max(0, options.maxChunks - started.size - smallerChunks)
        : Infinity;
      const outcome = await rescueGroup(
        group,
        rescuer,
        same,
        options,
        deps,
        limit,
      );
      // Only a rescue that ran counts as one, so a gated client is not listed.
      if (!same && outcome.ran)
        chain.rescued(head.origin, rescuer.client, "incomplete output");
      failures.push(...outcome.failed.values());
      quarantined.push(...outcome.quarantined);
      if (same) smallerChunks += outcome.ran;
      if (outcome.budget) {
        keepLeftovers(end);
        return {
          ran: started.size,
          failures,
          stopped: "budget-short",
          message: outcome.budget,
          quarantined,
          smallerChunks,
          ...chain.report(),
        };
      }
      start = end;
    }
  return {
    ran: started.size,
    failures,
    stopped,
    quarantined,
    smallerChunks,
    ...chain.report(),
  };
}
