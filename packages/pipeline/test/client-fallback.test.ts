import { expect, it, vi } from "vitest";
import {
  runSummaries,
  clientArgv,
  type AgentOptions,
  type AgentDeps,
  type Client,
} from "../src/agents";
const chunks = [0, 1, 2].map((i) => [
  { paperId: `pap_${i}`, title: "T", abstract: "A" },
]);
const text = (id: string) =>
  `=== ${id}\ntldr: T\nmotivation: M\nmethod: M\nresult: R\nconclusion: C`;
const options: AgentOptions = {
  client: "claude",
  lang: "en",
  parallel: 2,
  maxChunks: 10,
  fallback: ["codex", "antigravity"],
};
function fake(
  run: (client: string, index: number) => { code: number; text: string },
) {
  const upload = vi.fn<AgentDeps["upload"]>(async () => {}),
    usage = vi.fn<AgentDeps["usage"]>(async () => null);
  const preflight = vi.fn(async (client: Client) => ({
    client,
    usable: true,
    reason: "ready",
  }));
  return {
    upload,
    usage,
    preflight,
    run: vi.fn(async (_argv, _papers, index, _attempt, context) =>
      run(context.client, index),
    ),
  };
}
it.each([
  "OAuth session expired",
  "not logged in",
  "Please run /login",
  "Invalid API key",
  "401",
  "Unauthorized",
  "sign in",
])("A3 switches on %s and uploads the actual author", async (reason) => {
  const deps = fake((client, index) =>
    client === "claude"
      ? { code: 1, text: reason }
      : { code: 0, text: text(`pap_${index}`) },
  );
  const result = await runSummaries(chunks, options, deps);
  expect(result.fallback).toEqual([
    { from: "claude", to: "codex", reason: "authentication" },
  ]);
  expect(result.clientsUsed).toEqual(["claude", "codex"]);
  expect(
    deps.upload.mock.calls
      .flatMap((c) => c[0])
      .every((s) => s.client === "codex"),
  ).toBe(true);
  expect(deps.preflight.mock.calls.map((c) => c[0])).toEqual([
    "claude",
    "codex",
    "antigravity",
  ]);
  expect(result.failures).toEqual([]);
});
it("A3 skips absent codex, changes client on mid-run quota, and gates only Claude", async () => {
  const deps = fake((client, index) =>
    client === "claude" && index === 1
      ? { code: 1, text: "quota exhausted" }
      : { code: 0, text: text(`pap_${index}`) },
  );
  deps.preflight.mockImplementation(async (client) => ({
    client,
    usable: client !== "codex",
    reason: client === "codex" ? "cannot start" : "ready",
  }));
  const result = await runSummaries(chunks, { ...options, parallel: 1 }, deps);
  expect(result.fallback).toEqual([
    { from: "claude", to: "antigravity", reason: "quota exhausted" },
  ]);
  expect(deps.usage).toHaveBeenCalledTimes(2);
  expect(
    deps.upload.mock.calls.flatMap((c) => c[0]).map((s) => s.client),
  ).toEqual(["claude", "antigravity", "antigravity"]);
});
it("A4 all unusable is a clear error and uploads nothing", async () => {
  const deps = fake(() => ({ code: 0, text: "" }));
  deps.preflight.mockImplementation(async (client) => ({
    client,
    usable: false,
    reason: "not logged in",
  }));
  const result = await runSummaries(chunks, options, deps);
  expect(result.stopped).toContain("No usable agent client");
  expect(result.preflight).toHaveLength(3);
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.upload).not.toHaveBeenCalled();
});
it("A3 cannot-start uses fallback, ordinary failures don't, and empty fallback disables it", async () => {
  for (const mode of ["start", "ordinary", "disabled"]) {
    const deps = fake((client, index) =>
      client === "claude"
        ? {
            code: 1,
            text: mode === "start" ? "Cannot start client" : "ordinary error",
          }
        : { code: 0, text: text(`pap_${index}`) },
    );
    const result = await runSummaries(
      chunks,
      { ...options, fallback: mode === "disabled" ? [] : options.fallback },
      deps,
    );
    expect(result.fallback).toHaveLength(mode === "start" ? 1 : 0);
  }
});
it("A3 quarantine covers every fallback and never uploads leaked output", async () => {
  const deps = fake((client, index) =>
    client === "claude"
      ? { code: 1, text: "Unauthorized" }
      : {
          code: 0,
          text: text(`pap_${index}`) + "\n" + "lsk_" + "Q".repeat(52),
        },
  );
  const result = await runSummaries(chunks, options, deps);
  expect(result.quarantined).toEqual([0, 1, 2]);
  expect(deps.upload).not.toHaveBeenCalled();
});
it("A1/A2 built-in argv are exact and configured restrictions cannot be replaced", () => {
  // Prompts go on stdin: Linux caps one argument at 128 KB, and a digest
  // prompt is about 1 MB.
  expect(clientArgv("claude", "P")).toEqual([
    "claude",
    "-p",
    "--model",
    "haiku",
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ]);
  expect(clientArgv("codex", "P", "m")).toEqual([
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
    "-m",
    "m",
    "-",
  ]);
  const agy = clientArgv("antigravity", "P");
  expect(agy).toEqual([
    "agy",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--settings",
    expect.any(String),
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout",
    "840s",
    "--model",
    "gemini-4-hydrogen-medium",
    "-p=",
  ]);
  expect(agy.join(" ")).not.toContain("P ");
  expect(JSON.parse(agy[6]!)).toMatchObject({
    toolPermission: "strict",
    permissions: {
      deny: expect.arrayContaining([
        "command(*)",
        "mcp(*)",
        "read_file(/)",
        "write_file(/)",
      ]),
    },
  });
  for (const flag of [
    "--settings",
    "--mode",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--add-dir",
  ])
    expect(() =>
      clientArgv("antigravity", "P", undefined, [
        "fake",
        "{prompt}",
        flag + "=value",
      ]),
    ).toThrow(/restrictions/);
  for (const flag of [
    "-c",
    "--config",
    "--sandbox",
    "-s",
    "--dangerously-bypass-approvals-and-sandbox",
  ])
    expect(() =>
      clientArgv("codex", "P", undefined, [
        "fake",
        "{prompt}",
        flag + "=value",
      ]),
    ).toThrow(/restrictions/);
});
it("A5 hands papers still missing after a retry to the next client once, and keeps the run's client", async () => {
  // 2026-11-19: claude returned 5 of 20 chunks incomplete after a retry and
  // 65 papers waited for the next run, so the day had no digest by 11:30.
  const pairs = [0, 1, 2].map((i) => [
    { paperId: `pap_${i}a`, title: "T", abstract: "A" },
    { paperId: `pap_${i}b`, title: "T", abstract: "A" },
  ]);
  const deps = fake((client, index) =>
    client === "claude" && index === 1
      ? { code: 0, text: text(`pap_${index}a`) }
      : {
          code: 0,
          text: [text(`pap_${index}a`), text(`pap_${index}b`)].join("\n"),
        },
  );
  const result = await runSummaries(pairs, options, deps);
  expect(result.failures).toEqual([]);
  expect(result.clientsUsed).toEqual(["claude", "codex"]);
  expect(result.fallback).toEqual([
    { from: "claude", to: "codex", reason: "incomplete output" },
  ]);
  const authors = Object.fromEntries(
    deps.upload.mock.calls
      .flatMap((c) => c[0])
      .map((s) => [s.paperId, s.client]),
  );
  expect(authors).toEqual({
    pap_0a: "claude",
    pap_0b: "claude",
    pap_1a: "claude",
    pap_1b: "codex",
    pap_2a: "claude",
    pap_2b: "claude",
  });
  // The rescue sees only the missing paper.
  const rescue = deps.run.mock.calls.find((c) => c[4].client === "codex")!;
  expect(rescue[1].map((p: { paperId: string }) => p.paperId)).toEqual([
    "pap_1b",
  ]);
});
it("A5 keeps the failure when the rescue is incomplete too, or when there is no next client", async () => {
  const pairs = [
    [
      { paperId: "pap_0a", title: "T", abstract: "A" },
      { paperId: "pap_0b", title: "T", abstract: "A" },
    ],
  ];
  for (const fallback of [["codex"], []] as Client[][]) {
    const deps = fake(() => ({ code: 0, text: text("pap_0a") }));
    const result = await runSummaries(pairs, { ...options, fallback }, deps);
    expect(result.failures).toEqual(["chunk 0: 1 of 2 complete after a retry"]);
    expect(result.clientsUsed).toEqual(
      fallback.length ? ["claude", "codex"] : ["claude"],
    );
  }
});
it("A5 quarantines leaked rescue output like any other, and uploads none of it", async () => {
  const pairs = [
    [
      { paperId: "pap_0a", title: "T", abstract: "A" },
      { paperId: "pap_0b", title: "T", abstract: "A" },
    ],
  ];
  const deps = fake((client) =>
    client === "claude"
      ? { code: 0, text: text("pap_0a") }
      : { code: 0, text: text("pap_0b") + "\n" + "lsk_" + "Q".repeat(52) },
  );
  const result = await runSummaries(pairs, options, deps);
  expect(result.quarantined).toEqual([0]);
  expect(result.failures).toEqual(["chunk 0: quarantined output"]);
  expect(
    deps.upload.mock.calls.flatMap((c) => c[0]).map((s) => s.paperId),
  ).toEqual(["pap_0a"]);
});
const pair = (i: number) => [
  { paperId: `pap_${i}a`, title: "T", abstract: "A" },
  { paperId: `pap_${i}b`, title: "T", abstract: "A" },
];
it("A5 does not rescue after the usage gate stopped the run, nor with a gated claude", async () => {
  // Claude leaves chunk 0 incomplete, then its usage passes the gate.
  const gated = fake(() => ({ code: 0, text: text("pap_0a") }));
  gated.usage
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ fiveHour: 90, weekly: 10 });
  const stopped = await runSummaries(
    [pair(0), pair(1)],
    { ...options, parallel: 1 },
    gated,
  );
  expect(stopped.stopped).toBe("usage gate");
  expect(stopped.clientsUsed).toEqual(["claude"]);
  expect(stopped.failures).toEqual(["chunk 0: 1 of 2 complete after a retry"]);
  // Codex leaves a paper out and the next client is a claude past its gate.
  const rescueByClaude = fake(() => ({ code: 0, text: text("pap_0a") }));
  rescueByClaude.usage.mockResolvedValue({ fiveHour: 95, weekly: 10 });
  const result = await runSummaries(
    [pair(0)],
    { ...options, client: "codex", fallback: ["claude"] },
    rescueByClaude,
  );
  expect(result.clientsUsed).toEqual(["codex"]);
  expect(result.failures).toEqual(["chunk 0: 1 of 2 complete after a retry"]);
});
it("A5 rescues with the client after the one that left the papers out, even after the chain moved", async () => {
  // Claude leaves chunk 0 incomplete; chunk 1 fails authentication, so the
  // chain moves to codex. Codex never saw chunk 0, so codex rescues it.
  const deps = fake((client, index) => {
    if (client === "claude")
      return index === 0
        ? { code: 0, text: text("pap_0a") }
        : { code: 1, text: "Unauthorized" };
    return {
      code: 0,
      text: [text(`pap_${index}a`), text(`pap_${index}b`)].join("\n"),
    };
  });
  const result = await runSummaries(
    [pair(0), pair(1)],
    { ...options, parallel: 1 },
    deps,
  );
  expect(result.failures).toEqual([]);
  expect(result.fallback).toEqual([
    { from: "claude", to: "codex", reason: "authentication" },
    { from: "claude", to: "codex", reason: "incomplete output" },
  ]);
  const rescue = deps.run.mock.calls.filter(
    (c) => c[4].client === "codex" && c[2] === 0,
  );
  expect(rescue.length).toBeGreaterThan(0);
  expect(deps.run.mock.calls.some((c) => c[4].client === "antigravity")).toBe(
    false,
  );
});
it("A5 keeps an incomplete chunk's failure when the run stops for budget", async () => {
  const deps = fake((_client, index) =>
    index === 0
      ? { code: 0, text: text("pap_0a") }
      : ({ code: 0, text: "", budgetShort: "rows exhausted" } as never),
  );
  const result = await runSummaries(
    [pair(0), pair(1)],
    { ...options, parallel: 1 },
    deps,
  );
  expect(result.stopped).toBe("budget-short");
  expect(result.failures).toEqual(["chunk 0: 1 of 2 complete after a retry"]);
});
// 2026-11-19 10:20: claude answered 21, 8, 39, 38 and 29 of 40 papers after a
// retry that resent all 40, and the digest waited two hours for the next run.
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    paperId: `pap_${String(i).padStart(2, "0")}`,
    title: "T",
    abstract: "A",
  }));
// A client whose answer stops after `limit` summaries, as a cut-off output does.
const cutOff = (limit: number) => {
  const deps = fake(() => ({ code: 0, text: "" }));
  deps.run.mockImplementation(async (_argv, papers: { paperId: string }[]) => ({
    code: 0,
    text: papers
      .slice(0, limit)
      .map((p) => text(p.paperId))
      .join("\n"),
  }));
  return deps;
};
const sent = (deps: ReturnType<typeof fake>) =>
  deps.run.mock.calls.map((c) =>
    (c[1] as { paperId: string }[]).map((p) => p.paperId),
  );

it("A6 retries only the papers a chunk left out", async () => {
  const deps = cutOff(10);
  const result = await runSummaries([many(15)], options, deps);
  expect(sent(deps).map((ids) => ids.length)).toEqual([15, 5]);
  expect(sent(deps)[1]).toEqual(
    many(15)
      .slice(10)
      .map((p) => p.paperId),
  );
  expect(result.failures).toEqual([]);
  expect(result.fallback).toEqual([]);
  expect(deps.upload.mock.calls.flatMap((c) => c[0])).toHaveLength(15);
});

it("A6 gives leftovers to the same client in smaller chunks when no other client can take them", async () => {
  for (const setup of ["no fallback", "fallback unusable"] as const) {
    const deps = cutOff(11);
    if (setup === "fallback unusable")
      deps.preflight.mockImplementation(async (client) => ({
        client,
        usable: client === "claude",
        reason: client === "claude" ? "ready" : "cannot start",
      }));
    const result = await runSummaries(
      [many(40)],
      { ...options, fallback: setup === "no fallback" ? [] : ["codex"] },
      deps,
    );
    // 11 of 40, then 11 of the 29 missing, then 18 left in chunks of 10.
    expect(
      sent(deps).map((ids) => ids.length),
      setup,
    ).toEqual([40, 29, 10, 8]);
    expect(result.failures, setup).toEqual([]);
    expect(result).toMatchObject({
      clientsUsed: ["claude"],
      fallback: [],
      smallerChunks: 2,
    });
    expect(
      new Set(deps.upload.mock.calls.flatMap((c) => c[0]).map((s) => s.paperId))
        .size,
    ).toBe(40);
  }
});

it("A6 keeps the next client's rescue when there is one, and the count when smaller chunks fall short", async () => {
  const deps = cutOff(11);
  const result = await runSummaries([many(40)], options, deps);
  expect(result.fallback).toEqual([
    { from: "claude", to: "codex", reason: "incomplete output" },
  ]);
  expect(result.smallerChunks).toBe(0);

  const short = cutOff(4);
  const partial = await runSummaries(
    [many(20)],
    { ...options, fallback: [] },
    short,
  );
  // 4 of 20, then 4 of 16; the 12 left go in chunks of 10 (4, then 4 of the
  // 6 missing) and 2. The two smaller chunks run side by side.
  expect(
    sent(short)
      .map((ids) => ids.length)
      .sort((a, b) => b - a),
  ).toEqual([20, 16, 10, 6, 2]);
  expect(partial.failures).toEqual(["chunk 0: 8 of 20 complete after a retry"]);
  expect(partial.smallerChunks).toBe(2);
});

it("A6 does not call a paid API again for leftovers: its answers are checked JSON, not cut-off prose", async () => {
  const deps = cutOff(1);
  const result = await runSummaries(
    [many(2)],
    { ...options, client: "api", fallback: [] },
    deps,
  );
  // An API answer must cover every paper asked, so 1 of 2 is invalid twice.
  expect(sent(deps).map((ids) => ids.length)).toEqual([2, 2]);
  expect(result.smallerChunks).toBe(0);
  expect(result.failures).toEqual([
    "chunk 0: invalid summary JSON after a retry",
  ]);
});

it("A6 quarantines a retry only for secret-like text from outside the whole chunk", async () => {
  const hex = "deadbeef".repeat(4);
  const pair = [
    { paperId: "pap_a", title: "T", abstract: `Checksum ${hex} in data` },
    { paperId: "pap_b", title: "T", abstract: "A" },
  ];
  const deps = fake(() => ({ code: 0, text: "" }));
  deps.run.mockImplementation(async (_argv, papers: { paperId: string }[]) => ({
    code: 0,
    // The retry echoes the first paper's checksum next to the missing summary.
    text:
      papers.length === 2 ? text("pap_a") : `${text("pap_b")}\n(see ${hex})`,
  }));
  const result = await runSummaries([pair], { ...options, fallback: [] }, deps);
  expect(result.quarantined).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(deps.upload.mock.calls.flatMap((c) => c[0])).toHaveLength(2);
});

it("A6 checks the usage gate before every rescue batch", async () => {
  const deps = cutOff(11);
  let calls = 0;
  deps.usage.mockImplementation(async () =>
    ++calls >= 3 ? { fiveHour: 95, weekly: 10 } : { fiveHour: 10, weekly: 10 },
  );
  const result = await runSummaries(
    [many(40)],
    { ...options, fallback: [], parallel: 1 },
    deps,
  );
  // 11, then 11 of 29; of the 18 left, the second chunk of 8 is gated.
  expect(sent(deps).map((ids) => ids.length)).toEqual([40, 29, 10]);
  expect(result.smallerChunks).toBe(1);
  expect(result.failures).toEqual(["chunk 0: 22 of 40 complete after a retry"]);
});

it("A6 counts smaller chunks against the run's chunk budget", async () => {
  const deps = cutOff(5);
  const result = await runSummaries(
    [many(40)],
    { ...options, fallback: [], maxChunks: 3 },
    deps,
  );
  // One chunk ran; two of the three smaller chunks fit the budget of three.
  expect(result.smallerChunks).toBe(2);
  expect(
    sent(deps)
      .map((ids) => ids.length)
      .sort((a, b) => b - a),
  ).toEqual([40, 35, 10, 10, 5, 5]);
  expect(result.failures).toEqual(["chunk 0: 10 of 40 complete after a retry"]);
});
