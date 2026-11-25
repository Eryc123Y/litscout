import { expect, it, vi } from "vitest";
import { runSummaries, type AgentDeps } from "../src/agents";
const phrases = [
  "unauthorized access",
  "sign-in",
  "rate limit",
  "quota",
  "401",
];
const paper = { paperId: "pap_one", title: "T", abstract: "untrusted data" };
const summary = (phrase: string) =>
  `=== pap_one\ntldr: ${phrase}\nmotivation: M\nmethod: M\nresult: R\nconclusion: C`;
const options = {
  client: "claude" as const,
  lang: "en" as const,
  parallel: 1,
  maxChunks: 1,
  fallback: ["codex" as const],
};
it.each(phrases)(
  "R7 uploads successful model prose mentioning %s without fallback",
  async (phrase) => {
    const upload = vi.fn<AgentDeps["upload"]>(async () => {});
    const result = await runSummaries([[paper]], options, {
      run: async () => ({ code: 0, text: summary(phrase), diagnostic: phrase }),
      upload,
      usage: async () => null,
    });
    expect(result.fallback).toEqual([]);
    expect(result.stopped).toBeNull();
    expect(upload).toHaveBeenCalledWith([
      expect.objectContaining({
        client: "claude",
        content: expect.objectContaining({ tldr: phrase }),
      }),
    ]);
  },
);
it.each(phrases)(
  "R7 failed stderr mentioning %s still switches clients",
  async (phrase) => {
    let n = 0;
    const upload = vi.fn<AgentDeps["upload"]>(async () => {});
    const result = await runSummaries([[paper]], options, {
      run: async () =>
        ++n === 1
          ? { code: 1, text: "ordinary stdout", diagnostic: phrase }
          : { code: 0, text: summary("success") },
      upload,
      usage: async () => null,
    });
    expect(result.fallback).toHaveLength(1);
    expect(result.clientsUsed).toEqual(["claude", "codex"]);
    expect(upload).toHaveBeenCalledWith([
      expect.objectContaining({ client: "codex" }),
    ]);
  },
);
it("R7 incomplete blocks retry without interpreting good partial prose as an error", async () => {
  const upload = vi.fn<AgentDeps["upload"]>(async () => {});
  const run = vi
    .fn()
    .mockResolvedValueOnce({ code: 0, text: summary("quota") })
    .mockResolvedValueOnce({
      code: 0,
      text: summary("401").replaceAll("pap_one", "pap_two"),
    });
  const result = await runSummaries(
    [[paper, { ...paper, paperId: "pap_two" }]],
    options,
    { run, upload, usage: async () => null },
  );
  expect(result.fallback).toEqual([]);
  expect(upload.mock.calls[0]![0]).toHaveLength(2);
});
it("R7 failed attempts prefer stderr over parseable model text", async () => {
  const upload = vi.fn<AgentDeps["upload"]>(async () => {});
  const result = await runSummaries([[paper]], options, {
    run: async () => ({
      code: 1,
      text: summary("quota"),
      diagnostic: "ordinary process failure",
    }),
    upload,
    usage: async () => null,
  });
  expect(result.fallback).toEqual([]);
  expect(result.failures).toEqual(["chunk 0: client exited 1"]);
  expect(upload).not.toHaveBeenCalled();
});
it("keeps keys, home paths, addresses and prose out of the named cause", async () => {
  const { exitCause } = await import("../src/agent-chain");
  const address = ["ada", "example.org"].join("@");
  expect(
    exitCause({
      text: "",
      diagnostic: `Error: invalid key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx in /home/litscout/.codex/auth.json for ${address}`,
    }),
  ).toBe(": Error: invalid key ... in /.codex/auth.json for ...");
  // A prompt or abstract echoed to stderr is not an error line.
  expect(
    exitCause({
      text: "",
      diagnostic: "We reduce the standard error of the mean.\nwarning: done",
    }),
  ).toBe("");
  expect(exitCause({ text: "", diagnostic: "API Error: overloaded" })).toBe(
    ": API Error: overloaded",
  );
});
it("names the client's error line, not its warnings, when a chunk fails (11-24)", async () => {
  const result = await runSummaries([[paper]], options, {
    run: async () => ({
      code: 1,
      text: "",
      diagnostic:
        "warning: Codex could not find bubblewrap on PATH.\nError: turn/start failed: something {broke}\nwarning: trailing note",
    }),
    upload: vi.fn<AgentDeps["upload"]>(async () => {}),
    usage: async () => null,
  });
  expect(result.failures).toEqual([
    "chunk 0: client exited 1: Error: turn/start failed: something broke",
  ]);
});
