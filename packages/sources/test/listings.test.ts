import { readFileSync, readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  parseListing,
  fetchAbstracts,
  backfill,
  arxivClient,
} from "../src/listings";
import { hfUpvotes, readHuggingFace } from "../src/huggingface";
const directory = new URL("./fixtures/listings/", import.meta.url);
for (const file of readdirSync(directory).filter((f) => f.endsWith(".html"))) {
  it(`matches the Python spider on ${file}, every field in order`, async () => {
    const html = readFileSync(new URL(file, directory), "utf8");
    const expected = JSON.parse(
      readFileSync(
        new URL(file.replace(".html", ".golden.json"), directory),
        "utf8",
      ),
    );
    expect(
      (
        await parseListing(
          html,
          "cs.CV",
          file.includes("recent") ? "recent" : "new",
        )
      ).papers,
    ).toEqual(expected);
  });
}
it("batches abstracts, strips versions, spaces all calls and retries", async () => {
  const sleep = vi.fn(async () => {});
  let calls = 0;
  const fetch = vi.fn(async (url: string) => {
    if (++calls === 1) return new Response("busy", { status: 429 });
    const ids = new URL(url).searchParams.get("id_list")!.split(",");
    return new Response(
      `<feed xmlns="http://www.w3.org/2005/Atom">${ids.map((id) => `<entry><id>http://arxiv.org/abs/${id}v2</id><summary> First\n second </summary></entry>`).join("")}</feed>`,
    );
  });
  const found = await fetchAbstracts(
    Array.from({ length: 101 }, (_, i) => `2611.${i}`),
    { fetch: fetch as typeof globalThis.fetch, sleep },
  );
  expect(Object.keys(found)).toHaveLength(101);
  expect(found["2611.0"]).toBe("First second");
  expect(sleep.mock.calls).toEqual([[3000], [3000]]);
});
it("backfills only asked days, omits missing abstracts and preserves covered days", () => {
  const p = {
    id: "a",
    categories: [],
    title: "a",
    authors: [],
    pdf: "",
    abs: "",
    comment: null,
    summary: "",
    announced: "2026-11-16",
  };
  expect(
    backfill(
      [p, { ...p, id: "b" }, { ...p, announced: "2026-11-13" }],
      ["2026-11-16"],
      { a: "abstract" },
    ),
  ).toEqual({
    covered: ["2026-11-13", "2026-11-16"],
    gaps: ["2026-11-16"],
    days: {
      "2026-11-16": [{ ...p, announced: undefined, summary: "abstract" }],
    },
  });
});
it("fails on an invalid listing and exhausted API retries", async () => {
  await expect(parseListing("broken", "cs.CV", "new")).rejects.toThrow();
  await expect(
    fetchAbstracts(["a"], {
      fetch: vi.fn(async () => new Response("bad")) as typeof fetch,
      sleep: async () => {},
    }),
  ).rejects.toThrow();
});
it("shares the three-second throttle between listing and API requests", async () => {
  const sleep = vi.fn(async () => {});
  const impl = vi.fn(async () => new Response("ok"));
  const client = arxivClient(impl as typeof fetch, sleep);
  await client("https://arxiv.org/a");
  await client("https://export.arxiv.org/b");
  expect(sleep).toHaveBeenCalledExactlyOnceWith(3000);
});
it("HF keeps each paper's largest integer vote count, ignoring malformed entries", async () => {
  const lists = [
    [{ paper: { id: "a", upvotes: 2 } }, { paper: { id: "b", upvotes: 1.5 } }],
    [
      { paper: { id: "a", upvotes: 8 } },
      { paper: { id: "c", upvotes: -1 } },
      {},
    ],
  ];
  expect(hfUpvotes(lists)).toEqual({ a: 8, c: 0 });
  const fetch = vi.fn(async () => Response.json(lists[0]));
  expect(
    await readHuggingFace("2026-11-17", fetch as typeof globalThis.fetch),
  ).toEqual(lists[0]);
  await expect(
    readHuggingFace("bad", fetch as typeof globalThis.fetch),
  ).rejects.toThrow();
});
it("HF reads a date it has not opened yet as no papers, and still fails a past date", async () => {
  const fetch = vi.fn(
    async () => new Response('{"error":"date"}', { status: 400 }),
  ) as unknown as typeof globalThis.fetch;
  // 01:45 UTC: Hugging Face answers 400 for the new UTC date for a while.
  const now = () => new Date("2026-11-24T01:45:00Z");
  expect(await readHuggingFace("2026-11-24", fetch, now)).toEqual([]);
  await expect(readHuggingFace("2026-11-23", fetch, now)).rejects.toThrow(
    "Hugging Face HTTP 400",
  );
});

const newRow = (item: number, id: string, title = "A paper", extra = "") =>
  `<dt><a name="item${item}"></a><a title="Abstract" href="/abs/${id}">Abstract</a></dt>
   <dd><div class="list-title">Title: ${title}</div>${extra}</dd>`;

it("accepts a page with complete core sections and truncated replacements", async () => {
  const html = `<div id="dlpage"><h3>Showing new listings for Monday, 16 November 2026</h3>
    <div>Total of 2,100 entries</div>
    <h3>New submissions (showing 1 of 1 entries)</h3><dl>${newRow(1, "2611.00001")}</dl>
    <h3>Cross submissions (showing 1 of 1 entries)</h3><dl>${newRow(2, "2611.00002")}</dl>
    <h3>Replacement submissions (showing 1 of 2,098 entries)</h3><dl>${newRow(3, "2611.00003")}</dl>
    </div>`;
  const result = await parseListing(html, "cs.CV", "new");
  expect(result.complete).toBe(true);
  expect(result.papers.map((paper) => paper.id)).toEqual([
    "2611.00001",
    "2611.00002",
  ]);
});

it("keeps first submissions and timely cross-lists, excluding replacements and withdrawal notices", async () => {
  const html = `<div id="dlpage"><h3>Showing new listings for Monday, 16 November 2026</h3>
    <ul><li><a href="#item3">Cross submissions</a></li><li><a href="#item5">Replacement submissions</a></li></ul>
    <dl>${newRow(1, "2611.00001v1")}${newRow(2, "2611.00002", "[Withdrawn] Paper")}
    ${newRow(3, "2611.00003")}${newRow(4, "2611.00004v2")}
    ${newRow(5, "2611.00005")}${newRow(6, "2611.00006v3")}</dl></div>`;
  expect(
    (await parseListing(html, "cs.CV", "new")).papers.map((p) => p.id),
  ).toEqual(["2611.00001", "2611.00003"]);
});

it("does not use an explicit withdrawn abstract to recover a paper", async () => {
  const found = await fetchAbstracts(["2611.00001", "2611.00002"], {
    fetch: async () =>
      new Response(`<feed>
      <entry><id>http://arxiv.org/abs/2611.00001v2</id><summary>This paper has been withdrawn by the authors.</summary></entry>
      <entry><id>http://arxiv.org/abs/2611.00002v2</id><summary>This paper studies datasets that have been withdrawn by their authors.</summary></entry>
    </feed>`),
    sleep: async () => {},
  });
  expect(found).toEqual({
    "2611.00001": null,
    "2611.00002": expect.stringContaining("datasets"),
  });
});

it("retries both an empty Atom body and a truncated XML response before accepting complete XML", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(""))
    .mockResolvedValueOnce(new Response("<feed><entry>"))
    .mockResolvedValueOnce(
      new Response(
        "<feed><entry><id>https://arxiv.org/abs/2611.00001v1</id><summary>Complete.</summary></entry></feed>",
      ),
    );
  await expect(
    fetchAbstracts(["2611.00001"], { fetch, sleep: async () => {} }),
  ).resolves.toEqual({ "2611.00001": "Complete." });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("retries valid Atom that omits requested papers instead of accepting a partial recovery", async () => {
  const entry = (id: string) =>
    `<entry><id>https://arxiv.org/abs/${id}v1</id><summary>Recovered</summary></entry>`;
  const ids = ["2611.00001", "2611.00002"];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(`<feed>${entry(ids[0]!)}</feed>`))
    .mockResolvedValueOnce(
      new Response(`<feed>${ids.map(entry).join("")}</feed>`),
    );
  await expect(
    fetchAbstracts(ids, { fetch, sleep: async () => {} }),
  ).resolves.toEqual({
    "2611.00001": "Recovered",
    "2611.00002": "Recovered",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps abstracts returned across retries when a requested ID is persistently absent", async () => {
  const ids = ["2611.00001", "2611.00002", "2611.00003"];
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        `<feed><entry><id>https://arxiv.org/abs/2611.00002v1</id><summary>Second</summary></entry></feed>`,
      ),
  );
  fetch.mockResolvedValueOnce(
    new Response(
      `<feed><entry><id>https://arxiv.org/abs/2611.00001v1</id><summary>First</summary></entry></feed>`,
    ),
  );
  await expect(
    fetchAbstracts(ids, { fetch, sleep: async () => {} }),
  ).resolves.toEqual({ "2611.00001": "First", "2611.00002": "Second" });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("honors Retry-After on Atom's 503 and preserves the requested paper", async () => {
  const sleep = vi.fn(async () => {});
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response("busy", { status: 503, headers: { "Retry-After": "6" } }),
    )
    .mockResolvedValueOnce(
      new Response(
        "<feed><entry><id>https://arxiv.org/abs/2611.00001v1</id><summary>Complete.</summary></entry></feed>",
      ),
    );
  await expect(
    fetchAbstracts(["2611.00001"], { fetch, sleep }),
  ).resolves.toEqual({
    "2611.00001": "Complete.",
  });
  expect(sleep).toHaveBeenCalledWith(6000);
});
