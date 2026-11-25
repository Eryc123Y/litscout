import { expect, it, vi } from "vitest";
import { fetchRadarText } from "../src/fulltext";
import type { FeedItem } from "@litscout/pipeline/contracts/index";
const dns = vi.hoisted(() => ({
  addresses: [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("node:dns/promises", () => ({ lookup: async () => dns.addresses }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: "Safe text" }] }),
      }),
    }),
    destroy: async () => {},
  }),
}));
const api = { get: async () => null, write: vi.fn(async () => ({})) };
const paper = (url: string): FeedItem => ({
  paperId: "pap_p",
  title: "T",
  abstract: "A",
  source: "arxiv",
  authors: [],
  topics: [],
  shortlisted: true,
  summaries: [],
  identifiers: [],
  links: [{ kind: "pdf_oa", url, licence: null, oaStatus: "unknown" }],
});
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "0.0.0.0",
  "100.64.1.1",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "fd00::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
])("S5 rejects DNS result %s before fetching", async (address) => {
  dns.addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
  const fetch = vi.fn(async () => new Response("PDF"));
  await expect(
    fetchRadarText(
      "2026-11-17",
      "pap_p",
      [paper("https://private.localtest.me/paper")],
      api,
      fetch as typeof globalThis.fetch,
      2,
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("S5 rejects localhost. and any private result in a mixed DNS answer", async () => {
  dns.addresses = [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  const fetch = vi.fn(async () => new Response("PDF"));
  for (const url of ["https://localhost./paper", "https://mixed.example/paper"])
    await expect(
      fetchRadarText(
        "2026-11-17",
        "pap_p",
        [paper(url)],
        api,
        fetch as typeof globalThis.fetch,
        2,
      ),
    ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("S5 checks content-length before reading and cancels a stream as soon as 30 MB is exceeded", async () => {
  dns.addresses = [{ address: "93.184.216.34", family: 4 }];
  const cancel = vi.fn(),
    pull = vi.fn((c: ReadableStreamDefaultController<Uint8Array>) =>
      c.enqueue(new Uint8Array(1024)),
    );
  const declared = new Response(new ReadableStream({ pull, cancel }), {
    headers: { "content-length": "30000001" },
  });
  await expect(
    fetchRadarText(
      "2026-11-17",
      "pap_p",
      [paper("https://example.org/pdf")],
      api,
      vi.fn(async () => declared) as typeof fetch,
      2,
    ),
  ).rejects.toThrow("30 MB");
  expect(cancel).toHaveBeenCalledOnce();
  let read = 0;
  const cancel2 = vi.fn();
  const body = new ReadableStream(
    {
      pull(c) {
        read++;
        if (read > 2) {
          c.close();
          return;
        }
        c.enqueue(new Uint8Array(16000000));
      },
      cancel: cancel2,
    },
    { highWaterMark: 0 },
  );
  await expect(
    fetchRadarText(
      "2026-11-17",
      "pap_p",
      [paper("https://example.org/pdf")],
      api,
      vi.fn(async () => new Response(body)) as typeof fetch,
      2,
    ),
  ).rejects.toThrow("30 MB");
  expect(read).toBe(2);
  expect(cancel2).toHaveBeenCalledOnce();
});
