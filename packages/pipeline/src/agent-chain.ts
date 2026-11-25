import type { Client } from "@litscout/core/agent-config";
export type PreflightResult = {
  client: Client;
  usable: boolean;
  reason: string;
};
export type WriterOptions = {
  client: Client;
  model?: string;
  command?: readonly string[];
  fallback?: readonly Client[];
  timeout?: number;
};
export const defaultModel = (client: Client) =>
  client === "claude"
    ? "haiku"
    : client === "antigravity"
      ? "gemini-4-hydrogen-medium"
      : undefined;
export function fallbackReason(text: string) {
  if (/cannot start client/i.test(text)) return "cannot start";
  if (
    /OAuth session expired|not logged in|Please run \/login|Invalid API key|\b401\b|Unauthorized|sign[ -]in/i.test(
      text,
    )
  )
    return "authentication";
  if (
    /quota|usage limit|rate limit|capacity.*exhaust|out of.*credits/i.test(text)
  )
    return "quota exhausted";
  // Codex refuses a turn over 1,048,576 characters (2026-11-24); another
  // client may take it.
  if (
    /input exceeds the maximum length|input_too_large|prompt is too long|context length exceeded/i.test(
      text,
    )
  )
    return "input too large";
  return null;
}
export type AgentAnswer = {
  code: number;
  text: string;
  diagnostic?: string;
  timedOut?: boolean;
  budgetShort?: string;
};
/** A client's own error line: "Error: …", "API Error: …", "fatal: …". */
const errorLine = /^(?:[A-Za-z]+ )?(?:error|fatal)\b/i;
/**
 * The last error line of a failed client's stderr (else stdout), as ": <line>"
 * for the run log and its push notification, or "" when there is none
 * (11-24: "Client exited 1" alone hid Codex's input limit). Only a line that
 * starts as an error counts, so an echoed prompt or abstract is never taken;
 * addresses, home folders and long tokens are blanked, and the line is cut
 * to 200 characters.
 */
export function exitCause(answer: Pick<AgentAnswer, "text" | "diagnostic">) {
  // Stderr when there is any: stdout may be model prose.
  const line = (answer.diagnostic?.trim() ? answer.diagnostic : answer.text)
    .split("\n")
    .map((l) => l.trim())
    .findLast((l) => errorLine.test(l));
  const cleaned = (line ?? "")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "...")
    .replace(/\/(?:Users|home|root)\/[^\s/]+/g, "")
    .replace(/[\w\-.=+/]{24,}/g, "...")
    .replace(/[^\w\s.,:;"'$()/-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned ? `: ${cleaned}` : "";
}
const parseOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** The end of the balanced `{...}` starting at `start`, skipping braces in strings. */
function objectEnd(text: string, start: number) {
  let depth = 0,
    quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}
/** Brace groups in prose that are not JSON; past this, the answer is not a draft. */
const maxObjectTries = 20;
/**
 * The JSON in an agent's answer: the whole answer (optionally one code fence),
 * else the first balanced top-level object that parses, so a draft with prose
 * or a fence around it is still read (Claude Code, 2026-11-22). The caller
 * validates the value; nothing here drops keys.
 */
export function parseAgentJson(text: string): unknown {
  const whole = parseOrNull(
    text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""),
  );
  if (whole !== null) return whole;
  let tries = 0;
  for (
    let start = text.indexOf("{");
    start >= 0 && tries < maxObjectTries;
    tries++
  ) {
    const end = objectEnd(text, start);
    const value = end < 0 ? null : parseOrNull(text.slice(start, end + 1));
    if (value !== null) return value;
    // An unclosed group may still hold a complete object further on.
    start = text.indexOf("{", end < 0 ? start + 1 : end + 1);
  }
  return null;
}
/** Valid model prose is data, even when stderr or the answer contains error words. */
export function failedAttemptReason(
  answer: AgentAnswer,
  parseable: boolean,
  diagnosticOnly = false,
) {
  if (answer.timedOut || (answer.code === 0 && parseable)) return null;
  return fallbackReason(
    answer.diagnostic?.trim() ||
      (parseable || diagnosticOnly ? "" : answer.text),
  );
}
export class ClientChain {
  preflight: PreflightResult[] = [];
  clientsUsed: Client[] = [];
  fallback: { from: Client; to: Client; reason: string }[] = [];
  private index = 0;
  constructor(private options: WriterOptions) {}
  async check(check?: (client: Client) => Promise<PreflightResult>) {
    const clients = [
      ...new Set([this.options.client, ...(this.options.fallback ?? [])]),
    ];
    for (const client of clients)
      this.preflight.push(
        check
          ? await check(client).catch(() => ({
              client,
              usable: false,
              reason: "check failed",
            }))
          : { client, usable: true, reason: "injected runner" },
      );
    const first = this.preflight.findIndex((r) => r.usable);
    if (first < 0) return false;
    this.index = first;
    if (first > 0)
      this.fallback.push({
        from: clients[0]!,
        to: clients[first]!,
        reason: this.preflight[0]!.reason,
      });
    return true;
  }
  current(): WriterOptions {
    const client = this.preflight[this.index]!.client;
    return {
      client,
      model: client === this.options.client ? this.options.model : undefined,
      command:
        client === this.options.client ? this.options.command : undefined,
      timeout: this.options.timeout,
    };
  }
  used() {
    const c = this.current().client;
    if (!this.clientsUsed.includes(c)) this.clientsUsed.push(c);
  }
  advance(reason: string) {
    const from = this.current().client;
    const next = this.preflight.findIndex((r, i) => i > this.index && r.usable);
    if (next < 0) return false;
    this.index = next;
    this.fallback.push({ from, to: this.current().client, reason });
    return true;
  }
  /**
   * The client for a one-off rescue of papers `origin` left incomplete: the
   * current client if the chain has since moved past `origin`, otherwise the
   * next usable one. The chain does not move.
   */
  rescueFor(origin: Client): WriterOptions | null {
    const from = this.preflight.findIndex((r) => r.client === origin);
    const next =
      this.index > from
        ? this.index
        : this.preflight.findIndex((r, i) => i > this.index && r.usable);
    if (next < 0) return null;
    return {
      client: this.preflight[next]!.client,
      model: undefined,
      command: undefined,
      timeout: this.options.timeout,
    };
  }
  /**
   * The client that left papers incomplete, for one more pass of its own when
   * no other client can take them. Null when it was never usable, and for the
   * API: its answers are checked JSON after a repair, not cut-off prose, so a
   * third paid call would fail the same way.
   */
  retryFor(origin: Client): WriterOptions | null {
    if (origin === "api") return null;
    const at = this.preflight.findIndex((r) => r.client === origin);
    if (at < 0 || !this.preflight[at]!.usable) return null;
    const configured = origin === this.options.client;
    return {
      client: origin,
      model: configured ? this.options.model : undefined,
      command: configured ? this.options.command : undefined,
      timeout: this.options.timeout,
    };
  }
  rescued(from: Client, to: Client, reason: string) {
    if (!this.clientsUsed.includes(to)) this.clientsUsed.push(to);
    this.fallback.push({ from, to, reason });
  }
  report() {
    return {
      clientsUsed: this.clientsUsed,
      fallback: this.fallback,
      preflight: this.preflight,
    };
  }
}
