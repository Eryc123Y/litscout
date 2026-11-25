import { expect, it, vi } from "vitest";
import { clientArgv, runSummaries } from "../src/agents";
import { defineConfig } from "@litscout/core";
import { readFileSync } from "node:fs";
const fields = (value: string) =>
  `=== pap_fixture\ntldr: ${value}\nmotivation: A problem\nmethod: An approach\nresult: A finding\nconclusion: A takeaway`;
const secret = "lsk_" + "A".repeat(52);
it("S1 disables Claude tools and restricts Codex and Gemini", () => {
  const claude = clientArgv("claude", "prompt");
  expect(claude[claude.indexOf("--tools") + 1]).toBe("");
  expect(claude).not.toContain("Read,Write");
  expect(clientArgv("codex", "prompt")).toContain("read-only");
  expect(clientArgv("gemini", "prompt")).toContain("--sandbox");
  expect(clientArgv("gemini", "prompt")).toContain("plan");
  expect(
    clientArgv("claude", "prompt", undefined, ["wrapper", "{prompt}"]),
  ).toContain("--tools");
  expect(() =>
    clientArgv("claude", "prompt", undefined, [
      "claude",
      "--tools",
      "Read,Write",
      "{prompt}",
    ]),
  ).toThrow();
  expect(() =>
    clientArgv("codex", "prompt", undefined, [
      "codex",
      "exec",
      "--full-auto",
      "{prompt}",
    ]),
  ).toThrow();
  expect(() =>
    clientArgv("gemini", "prompt", undefined, [
      "gemini",
      "--approval-mode",
      "yolo",
      "{prompt}",
    ]),
  ).toThrow();
});
it("S1 quarantines a mocked agent that obeys a credentials-reading injection and continues", async () => {
  const hostile = JSON.parse(
    readFileSync(
      new URL("./fixtures/hostile-abstract.json", import.meta.url),
      "utf8",
    ),
  );
  const safe = { ...hostile, abstract: "A normal paper." };
  const run = vi
    .fn()
    .mockResolvedValueOnce({ code: 0, text: fields(secret) })
    .mockResolvedValueOnce({ code: 0, text: fields("A normal result") });
  const upload = vi.fn(async () => {});
  const report = await runSummaries(
    [[hostile], [safe]],
    {
      client: "cmd",
      command: ["mock", "{prompt}"],
      lang: "en",
      parallel: 1,
      maxChunks: 2,
    },
    { run, upload, usage: async () => null },
  );
  expect(report).toMatchObject({ ran: 2, quarantined: [0] });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(upload.mock.calls)).not.toContain(secret);
});
it.each([
  "ssh-dss AAAA/BBBB/CCCC/AAAA/BBBB/CCCC",
  "---- BEGIN SSH2 PUBLIC KEY ----",
  ["sk-ssh-ed25519", "openssh.com"].join("@"),
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN",
  "ssh-ed25519 " + "B".repeat(50),
  "AKIA" + "A".repeat(16),
  "A".repeat(32),
  "abcdef0123456789".repeat(2),
])("S1 detects new secret-like output: %s", async (value) => {
  const upload = vi.fn(async () => {}),
    paper = { paperId: "pap_fixture", title: "T", abstract: "A" };
  const report = await runSummaries(
    [[paper]],
    { client: "codex", lang: "en", parallel: 1, maxChunks: 1 },
    {
      run: async () => ({ code: 0, text: fields(value) }),
      upload,
      usage: async () => null,
    },
  );
  expect(report).toMatchObject({ quarantined: [0] });
  expect(upload).not.toHaveBeenCalled();
});
it("S1 permits an identical identifier already present in input but discards earlier partial output on quarantine", async () => {
  const identifier = "a".repeat(40),
    paper = {
      paperId: "pap_fixture",
      title: "T",
      abstract: `Checkpoint ${identifier}`,
    },
    upload = vi.fn(async () => {});
  const result = await runSummaries(
    [[paper]],
    { client: "codex", lang: "en", parallel: 1, maxChunks: 1 },
    {
      run: async () => ({ code: 0, text: fields(identifier) }),
      upload,
      usage: async () => null,
    },
  );
  expect(result).toMatchObject({ quarantined: [] });
  expect(upload).toHaveBeenCalledOnce();
  upload.mockClear();
  let attempt = 0;
  const result2 = await runSummaries(
    [[paper, { ...paper, paperId: "pap_second" }]],
    { client: "codex", lang: "en", parallel: 1, maxChunks: 1 },
    {
      run: async () => ({
        code: 0,
        text: ++attempt === 1 ? fields("Partial") : fields(secret),
      }),
      upload,
      usage: async () => null,
    },
  );
  expect(result2).toMatchObject({ quarantined: [0] });
  expect(upload).not.toHaveBeenCalled();
});
it("S8 validates model names and value positions in command templates", () => {
  for (const model of ["--dangerous", "bad model", "name\nflag", ""])
    expect(() => defineConfig({ agent: { summaries: { model } } })).toThrow();
  expect(
    defineConfig({ agent: { summaries: { model: "provider:model-1.2" } } })
      .agent.summaries.model,
  ).toBe("provider:model-1.2");
  for (const command of [
    ["mock", "--model", "--unsafe", "{prompt}"],
    ["-bad", "{prompt}"],
    ["mock", "--model"],
  ])
    expect(() => defineConfig({ agent: { summaries: { command } } })).toThrow();
  expect(() =>
    clientArgv("cmd", "--unsafe", undefined, ["mock", "{prompt}"]),
  ).toThrow();
  expect(() => clientArgv("claude", "prompt", "--dangerous")).toThrow();
});

it.each([
  ["sk", false],
  ["sk-ant", false],
  ["sk-ant", true],
] as const)(
  "quarantines provider credentials from a summary (prefix %s, escaped %s)",
  async (prefix, escaped) => {
    const key = prefix + "-" + crypto.randomUUID().replaceAll("-", "_");
    const paper = {
      paperId: "pap_fixture",
      title: "A paper",
      abstract: "A result",
    };
    const answer = JSON.stringify({
      pap_fixture: {
        tldr: key,
        motivation: "M",
        method: "M",
        result: "R",
        conclusion: "C",
      },
    });
    const upload = vi.fn(async () => {});
    const report = await runSummaries(
      [[paper]],
      { client: "api", lang: "en", parallel: 1, maxChunks: 1 },
      {
        run: async () => ({
          code: 0,
          text: escaped
            ? answer.replace(key, "\\u0073" + key.slice(1))
            : answer,
        }),
        upload,
        usage: async () => null,
      },
    );
    expect(report).toMatchObject({ quarantined: [0] });
    expect(upload).not.toHaveBeenCalled();
  },
);
