import { expect, it, vi } from "vitest";
import {
  parseBlocks,
  formatChunk,
  instructions,
  subagentInstructions,
  clientArgv,
  digestArgv,
  runSummaries,
} from "../src/agents";
import { readFileSync } from "node:fs";
import {
  summaryTodo,
  digestContext,
  renderDigest,
  finalDecision,
  weeklyReview,
} from "../src/digest";
import { digestSchema } from "../src/contracts/index";
const fields = {
  tldr: "An overview",
  motivation: "A problem",
  method: "An approach",
  result: "A finding",
  conclusion: "A takeaway",
};
const output = (id: string) =>
  `=== ${id}\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`;
it("uses exactly the old five-field and subagent prompts in both languages", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/prompts.golden.json", import.meta.url),
      "utf8",
    ),
  );
  for (const language of ["English", "Chinese"]) {
    expect(instructions(language)).toBe(fixture[language].instructions);
    expect(subagentInstructions(language)).toBe(
      fixture[language].subagentInstructions,
    );
  }
});
it("asks for inline TeX only when summaries are set to tex, after cutover", () => {
  for (const language of ["English", "Chinese"]) {
    // The shadow run needs the old prompt byte for byte.
    expect(instructions(language, "plain")).toBe(instructions(language));
    expect(subagentInstructions(language, "plain")).toBe(
      subagentInstructions(language),
    );
    const tex = instructions(language, "tex");
    expect(tex.startsWith(instructions(language))).toBe(true);
    expect(tex).toMatch(/inline TeX between single dollar signs/);
    expect(tex).toContain("$\\ell_2$");
    expect(subagentInstructions(language, "tex")).toContain(tex);
  }
});
it("parses multiline and inline blocks, keeps first duplicates and rejects incomplete blocks", () => {
  const parsed = parseBlocks(
    output("p") +
      output("p") +
      "=== q\ntldr: hi\n=== r\n" +
      Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(" "),
  );
  expect(parsed.summaries).toEqual({ p: fields, r: fields });
  expect(parsed.problems).toHaveLength(2);
  expect(
    parseBlocks(
      "=== x\n" +
        Object.keys(fields)
          .map((k) => `${k}: `)
          .join("\n"),
    ).summaries,
  ).toEqual({});
  expect(formatChunk([{ paperId: "p", title: "A\nB", abstract: "C\nD" }])).toBe(
    "=== p\ntitle: A B\nabstract: C D\n",
  );
  expect(instructions("English")).toContain(
    "Use only what the abstract states",
  );
});
it("builds headless commands without a shell and validates custom templates", () => {
  expect(clientArgv("claude", "prompt")).toContain("--strict-mcp-config");
  expect(clientArgv("codex", "prompt")).toContain("read-only");
  expect(clientArgv("gemini", "prompt")).toContain("prompt");
  expect(clientArgv("cmd", "p", undefined, ["fake", "{prompt}"])).toEqual([
    "fake",
    "p",
  ]);
  expect(() => clientArgv("cmd", "p")).toThrow();
});
it("retries a short chunk once, merges both attempts and never uploads unknown ids", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ code: 0, text: output("p") })
    .mockResolvedValueOnce({ code: 0, text: output("q") + output("unknown") });
  const upload = vi.fn(async (_summaries: unknown[]) => {});
  const report = await runSummaries(
    [
      [
        { paperId: "p", title: "P", abstract: "A" },
        { paperId: "q", title: "Q", abstract: "B" },
      ],
    ],
    {
      client: "cmd",
      command: ["fake", "{prompt}"],
      lang: "en",
      parallel: 2,
      maxChunks: 3,
    },
    { run, upload, usage: async () => ({ fiveHour: 10, weekly: 20 }) },
  );
  expect(run).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls[0]![0]).toHaveLength(2);
  expect(report.failures).toEqual([]);
});
it("stops at >=80% usage, quota exhaustion or chunk budget", async () => {
  const chunk = [{ paperId: "p", title: "P", abstract: "A" }],
    run = vi.fn(async () => ({ code: 1, text: "quota exhausted" }));
  const deps = {
    run,
    upload: async () => {},
    usage: async () => ({ fiveHour: 80, weekly: 0 }),
  };
  expect(
    (
      await runSummaries(
        [chunk],
        { client: "claude", lang: "en", parallel: 1, maxChunks: 2 },
        deps,
      )
    ).stopped,
  ).toBe("usage gate");
  expect(run).not.toHaveBeenCalled();
  expect(
    (
      await runSummaries(
        [chunk],
        { client: "codex", lang: "en", parallel: 1, maxChunks: 2 },
        { ...deps, usage: async () => null },
      )
    ).stopped,
  ).toBe("quota exhausted");
  expect(
    (
      await runSummaries(
        [chunk],
        {
          client: "cmd",
          command: ["fake", "{prompt}"],
          lang: "en",
          parallel: 1,
          maxChunks: 0,
        },
        deps,
      )
    ).stopped,
  ).toBe("chunk budget");
});
const p = (id: string, abstract: string | null = "A", source = "arxiv") => ({
  paperId: id,
  title: id,
  abstract,
  source,
  authors: [{ name: "A" }],
  topics: ["Vision"],
  shortlisted: true,
  identifiers: [],
  links: [],
  summaries: [],
});
it("summary todo skips missing abstracts and only accepts the configured language", () => {
  const todo = summaryTodo(
    "2026-11-17",
    [
      p("p"),
      p("q", null),
      {
        ...p("r"),
        summaries: [
          {
            paperId: "r",
            lang: "zh" as const,
            content: fields,
            model: null,
            client: null,
          },
        ],
      },
    ],
    "en",
    40,
  );
  expect(todo.chunks[0]?.map((p) => p.paperId)).toEqual(["p", "r"]);
  expect(todo.noAbstract).toBe(1);
});
it("digest context includes all titles/TLDRs, project regex and 28 days of ratings", () => {
  const context = digestContext(
    "2026-11-17",
    [p("p"), { ...p("q"), title: "Data reuse" }],
    [{ path: "brief.md", body: "REUSE = reuse" }],
    [],
    "en",
  );
  expect(context.all).toHaveLength(2);
  expect(context.radar.map((p) => p.paperId)).toEqual(["q"]);
});
it("writes why a radar paper matters and the ways it could help into the Markdown digest", () => {
  const draft = digestSchema.parse({
    day: "2026-11-17",
    radar: [
      {
        paperId: "p",
        level: "borrow",
        reason: "Shows a prior survives shift.",
        relevance: "Your conversion fails on this shift.",
        angles: ["Borrow the prior.", "Add the split as a baseline."],
      },
    ],
  });
  const en = renderDigest(draft, [p("p")], [], "https://example.org");
  expect(en).toContain("Shows a prior survives shift.");
  expect(en).toContain("Why it matters: Your conversion fails on this shift.");
  expect(en).toContain(
    "Ways it could help: Borrow the prior.; Add the split as a baseline.",
  );
  const zh = renderDigest(
    { ...draft, lang: "zh" },
    [p("p")],
    [],
    "https://example.org",
  );
  expect(zh).toContain("为什么相关：Your conversion fails on this shift.");
  expect(zh).toContain(
    "可以怎么用：Borrow the prior.；Add the split as a baseline.",
  );
  // Entries written before these fields keep their old line.
  const old = digestSchema.parse({
    day: "2026-11-17",
    radar: [{ paperId: "p", level: "borrow", reason: "reuse" }],
  });
  expect(old.radar[0]).toMatchObject({ relevance: "", angles: [] });
  expect(renderDigest(old, [p("p")], [], "https://example.org")).not.toContain(
    "Why it matters",
  );
});
it("renders both languages in report order, deduping radar and topic picks", () => {
  const draft = digestSchema.parse({
    day: "2026-11-17",
    topics: { Vision: [{ paperId: "p", gist: "gist" }] },
    radar: [{ paperId: "p", level: "borrow", reason: "reuse" }],
    reportText: "A note",
  });
  const en = renderDigest(
    draft,
    [p("p")],
    [{ name: "Vision", keywords: [] }],
    "https://example.org",
  );
  expect(en).toContain("LitScout Daily");
  expect(en).toContain("Radar");
  expect(en.match(/paper=p/g)).toHaveLength(1);
  expect(
    renderDigest({ ...draft, lang: "zh" }, [p("p")], [], "https://example.org"),
  ).toContain("LitScout 日报");
});
it.each([false, true])(
  "uses source-aware reader routes and shows empty text only for zero matches (public=%s)",
  (isPublic) => {
    const day = "2026-11-16";
    const topic = "2D-to-3D and stereo";
    const draft = digestSchema.parse({
      day,
      radar: [
        {
          paperId: "pap_one",
          level: "borrow",
          reason: "reuse",
          project: "FYP · stereo conversion",
        },
      ],
    });
    const papers = [
      { ...p("pap_one", "A", "huggingface"), topics: [topic], hfUpvotes: 20 },
    ];
    const body = renderDigest(
      draft,
      papers,
      [
        { name: topic, keywords: [] },
        { name: "Language", keywords: [] },
      ],
      "https://reader.example/",
      isPublic,
    );
    const route = `https://reader.example/${isPublic ? "public" : "app"}/days/${day}`;
    expect(body).toContain(`[Open day](${route})`);
    expect(body).toContain(
      `(${route}?paper=pap_one&paperSource=huggingface) ▲20`,
    );
    expect(body).toContain(
      `(${route}?paper=pap_one&paperSource=huggingface&topic=2D-to-3D+and+stereo) (huggingface) — FYP · stereo conversion · borrow`,
    );
    expect(body).toContain(
      `**${topic}** (matched 1 · [All](${route}?topic=2D-to-3D+and+stereo))\n`,
    );
    expect(body).not.toContain("No 2D→3D / stereo papers today");
    // A topic with no matches reads the same whatever its name.
    const quiet = renderDigest(
      digestSchema.parse({ day }),
      [],
      [{ name: topic, keywords: [] }],
      "https://reader.example/",
      isPublic,
    );
    expect(quiet).toMatch(
      new RegExp(`\\*\\*${topic}\\*\\* \\(matched 0 .*\\): No picks today`),
    );
    expect(body).toMatch(/\*\*Language\*\* .*\): .+/);
    expect(body).not.toContain("#day=");
  },
);
it("final handles Sunday night, existing reports, pending summaries and no batch", () => {
  expect(finalDecision("2026-11-22", true, false, false, 0)).toBe(
    "sunday-stop",
  );
  expect(finalDecision("2026-11-17", true, true, true, 0)).toBe("exists");
  expect(finalDecision("2026-11-17", true, false, false, 0)).toBe(
    "no-batch-note",
  );
  expect(finalDecision("2026-11-17", true, false, true, 2)).toBe(
    "resume-summaries",
  );
  expect(finalDecision("2026-11-17", false, false, true, 2)).toBe(
    "summaries-pending",
  );
});
it("weekly uses no model, lists missed papers and rotates five look-back directions", () => {
  const out = weeklyReview(
    "2026-11-22",
    [{ day: "2026-11-17", bodyMd: "# daily", picks: [], radar: [] }],
    [p("p")],
    [],
    "en",
  );
  expect(out.bodyMd).toContain("Weekly");
  expect(out.lookBack).toHaveLength(1);
  expect(out.direction).toBeGreaterThanOrEqual(1);
});
it("keeps Claude Code sessions off disk and asks for checked JSON only for the digest", () => {
  const summaries = clientArgv("claude", "{chunkPrompt}");
  expect(summaries).toContain("--no-session-persistence");
  expect(summaries).not.toContain("--output-format");
  expect(
    clientArgv("claude", "p", undefined, ["wrapper", "{prompt}"]),
  ).toContain("--no-session-persistence");
  const schema = '{"type":"object"}';
  const digest = digestArgv(
    "claude",
    "{chunkPrompt}",
    undefined,
    undefined,
    900,
    schema,
  );
  expect(digest).toEqual([
    ...summaries,
    "--output-format",
    "json",
    "--json-schema",
    schema,
  ]);
  // Other clients and configured commands keep their usual argv.
  expect(
    digestArgv("codex", "{chunkPrompt}", undefined, undefined, 900, schema),
  ).toEqual(clientArgv("codex", "{chunkPrompt}"));
  expect(
    digestArgv("claude", "p", undefined, ["wrapper", "{prompt}"], 900, schema),
  ).toEqual(clientArgv("claude", "p", undefined, ["wrapper", "{prompt}"]));
});
it("calls the venue section venues: conference papers count as well as journals", () => {
  const draft = digestSchema.parse({
    day: "2026-11-17",
    journal: [{ paperId: "conf", gist: "A conference paper" }],
  });
  const papers = [
    p("a1"),
    { ...p("conf", "A", "openalex"), venue: "ICLR", venueKind: "conference" },
    { ...p("jour", "A", "crossref"), venue: "IJCV", venueKind: "journal" },
  ];
  const en = renderDigest(draft, papers, [], "https://example.org");
  expect(en).toContain("**1 new papers · venues 2**");
  expect(en).toContain("**From venues**: matched 2 (ICLR 1 · IJCV 1)");
  expect(en).not.toContain("From journals");
  const zh = renderDigest(
    { ...draft, lang: "zh" },
    papers,
    [],
    "https://example.org",
  );
  expect(zh).toContain("期刊和会议 2");
  expect(zh).toContain("**来自期刊和会议**");
});
