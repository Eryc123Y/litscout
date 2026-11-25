import { expect, it, vi } from "vitest";
import { fetchRadarText } from "../src/fulltext";
import type { FeedItem } from "@litscout/pipeline/contracts/index";
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [{ str: "Main body" }, { str: "Results" }],
        }),
      }),
    }),
    destroy: async () => {},
  }),
}));
const paper: FeedItem = {
  paperId: "p",
  title: "T",
  abstract: "A",
  authors: [],
  source: "arxiv",
  topics: [],
  shortlisted: true,
  summaries: [],
  identifiers: [],
  links: [
    {
      kind: "pdf_arxiv",
      url: "https://arxiv.org/pdf/2611.00001",
      licence: null,
      oaStatus: "unknown",
    },
  ],
};
it("allows at most two distinct radar papers, rejects unknown and unsafe links", async () => {
  const api = {
      get: async () => ({ value: '["a","b"]' }),
      write: vi.fn(async () => ({})),
    },
    fetch = vi.fn(async () => new Response("PDF"));
  await expect(
    fetchRadarText(
      "2026-11-17",
      "p",
      [paper],
      api,
      fetch as typeof globalThis.fetch,
      2,
    ),
  ).rejects.toThrow("At most two");
  await expect(
    fetchRadarText(
      "2026-11-17",
      "unknown",
      [paper],
      api,
      fetch as typeof globalThis.fetch,
      2,
    ),
  ).rejects.toThrow("restricted");
  for (const url of [
    "http://example.org/a",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://" + ["user:pass", "example.org/a"].join("@"),
  ])
    await expect(
      fetchRadarText(
        "2026-11-17",
        "p",
        [{ ...paper, links: [{ ...paper.links[0]!, url }] }],
        { ...api, get: async () => null },
        fetch as typeof globalThis.fetch,
        2,
      ),
    ).rejects.toThrow("public HTTPS");
  expect(fetch).not.toHaveBeenCalled();
});
it("reads text in memory, records a successful full-text request and reports unavailable OA", async () => {
  const api = { get: async () => null, write: vi.fn(async () => ({})) },
    fetch = vi.fn(async () => new Response("PDF"));
  expect(
    await fetchRadarText(
      "2026-11-17",
      "p",
      [paper],
      api,
      fetch as typeof globalThis.fetch,
      2,
    ),
  ).toMatchObject({ text: "Main body Results\n" });
  expect(api.write).toHaveBeenCalledOnce();
  expect(
    await fetchRadarText(
      "2026-11-17",
      "p",
      [{ ...paper, links: [] }],
      api,
      fetch as typeof globalThis.fetch,
      2,
    ),
  ).toMatchObject({ text: null });
  expect(
    await fetchRadarText(
      "2026-11-17",
      "p",
      [paper],
      api,
      vi.fn(
        async () => new Response("", { status: 404 }),
      ) as typeof globalThis.fetch,
      2,
    ),
  ).toMatchObject({ text: null, reason: "Full text HTTP 404" });
});
