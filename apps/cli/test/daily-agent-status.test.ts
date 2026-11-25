import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runDaySummaries } from "../src/summary-command";
import type { FlowDeps } from "../src/flow-runtime";

const day = "2026-11-17";

function summaries() {
  const page = {
    day,
    status: "crawled",
    noAbstract: 0,
    nextCursor: null,
    counts: {
      total: 1,
      summarised: 0,
      shortlisted: 1,
      arxiv: 1,
      venues: 0,
      topics: {},
      sources: { arxiv: 1 },
      venueCounts: {},
    },
    items: [{ paperId: "pap_fixture", title: "Fixture", abstract: "Text" }],
  };
  const api = {
    get: vi.fn(async () => page),
    write: vi.fn(async (_path: string, _body: unknown) => ({})),
  };
  const agent = vi.fn<NonNullable<NonNullable<FlowDeps["flow"]>["agent"]>>();
  const flow: FlowDeps["flow"] = {
    agent,
    now: () => new Date(day),
    preflight: async (client) => ({ client, usable: true, reason: "fixture" }),
  };
  const deps = { flow } as FlowDeps;
  const run = (namedDay = false) =>
    runDaySummaries(
      day,
      api,
      deps,
      defineConfig({}),
      {
        client: "claude",
        fallback: ["codex", "antigravity"],
        lang: "en",
        parallel: 1,
        maxChunks: 1,
        timeout: 1,
      },
      1,
      false,
      namedDay,
    );
  return { api, agent, run, page };
}

it.each([
  { invalid: [], status: "done" },
  {
    invalid: [
      { day, id: "pap_fixture", field: "paperId", reason: "Unknown paper" },
    ],
    status: "error",
  },
])(
  "counts server skips as complete only when the row is valid ($status)",
  async ({ invalid, status }) => {
    const h = summaries();
    h.agent.mockResolvedValue({
      code: 0,
      text: "=== pap_fixture\ntldr: One\nmotivation: Two\nmethod: Three\nresult: Four\nconclusion: Five",
    });
    h.api.write.mockImplementation(async (route) => {
      if (route === "/ingest/summaries") {
        if (!invalid.length)
          h.api.get.mockResolvedValue({ ...h.page, items: [] });
        return { accepted: 0, skipped: 1, invalid };
      }
      return {};
    });
    await expect(h.run()).resolves.toMatchObject({ status });
    if (!invalid.length) {
      await expect(h.run()).resolves.toMatchObject({ status: "done", ran: 0 });
      expect(h.agent).toHaveBeenCalledTimes(1);
    }
  },
);

it("retries invalid summary JSON once and reports failure if nothing can be uploaded", async () => {
  const h = summaries();
  h.agent.mockResolvedValue({ code: 0, text: "{malformed" });
  // The next client gets one rescue pass (M4z) before the chunk counts as failed.
  await expect(h.run()).resolves.toMatchObject({
    status: "error",
    day,
    ran: 1,
    clientsUsed: ["claude", "codex"],
    fallback: [{ from: "claude", to: "codex", reason: "incomplete output" }],
    failures: ["chunk 0: 0 of 1 complete after a retry"],
  });
  // Claude and the rescue client each answer and retry once.
  expect(h.agent).toHaveBeenCalledTimes(4);
  expect(h.api.write).toHaveBeenCalledExactlyOnceWith(
    "/ingest/legacy",
    expect.objectContaining({
      runs: [expect.objectContaining({ status: "error" })],
    }),
    50,
  );
});

it("tries eligible fallback clients in order and reports an error if every client fails authentication or startup", async () => {
  const h = summaries();
  h.agent
    .mockResolvedValueOnce({ code: 1, text: "Unauthorized" })
    .mockResolvedValueOnce({ code: 1, text: "Cannot start client" })
    .mockResolvedValueOnce({ code: 1, text: "Not logged in" });
  await expect(h.run()).resolves.toMatchObject({
    status: "error",
    day,
    ran: 1,
    clientsUsed: ["claude", "codex", "antigravity"],
    stopped: "authentication",
    fallback: [
      { from: "claude", to: "codex", reason: "authentication" },
      { from: "codex", to: "antigravity", reason: "cannot start" },
    ],
  });
  expect(h.api.write.mock.calls.map(([route]) => route)).toEqual([
    "/ingest/legacy",
  ]);
});

it("summarises a day without an arXiv listing only when that day is named", async () => {
  const h = summaries();
  const venueOnly = {
    ...h.page,
    status: "pending",
    counts: { ...h.page.counts, arxiv: 0, venues: 1, sources: { arxiv: 0 } },
  };
  h.api.get.mockResolvedValue(venueOnly);
  h.agent.mockResolvedValue({
    code: 0,
    text: "=== pap_fixture\ntldr: One\nmotivation: Two\nmethod: Three\nresult: Four\nconclusion: Five",
  });
  h.api.write.mockImplementation(async (route) => {
    if (route === "/ingest/summaries") {
      h.api.get.mockResolvedValue({ ...venueOnly, items: [] });
      return { accepted: 1, skipped: 0, invalid: [] };
    }
    return {};
  });
  await expect(h.run()).resolves.toMatchObject({ status: "no-new-batch" });
  expect(h.agent).not.toHaveBeenCalled();
  await expect(h.run(true)).resolves.toMatchObject({ status: "done" });
  expect(h.agent).toHaveBeenCalled();
});
