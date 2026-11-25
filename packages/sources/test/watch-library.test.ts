import { expect, it } from "vitest";
import { watchVenues } from "../src/watch/library";
import { harness, host } from "./helpers/watch-harness";
it("returns the same validated venue records through the library API", async () => {
  const item = {
    DOI: "10.1234/library",
    title: ["Depth stereo"],
    author: [{ given: "Ada", family: "Lovelace" }],
    created: { "date-parts": [[2026, 11, 11]] },
    published: { "date-parts": [[2026, 11, 11]] },
    type: "journal-article",
    abstract: "<jats:p>Abstract.</jats:p>",
  };
  const h = harness(
    [{ name: "Journal", kind: "journal", issn: ["1234-5678"] }],
    [
      {
        match: host("api.crossref.org"),
        respond: () => Response.json({ message: { items: [item] } }),
      },
    ],
  );
  const lines = await watchVenues(
    ["--since", "2026-11-10", "--venues", "list.json"],
    h.deps,
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    title: "Depth stereo",
    authors: ["Ada Lovelace"],
    source: "crossref",
    venue: "Journal",
  });
  await expect(watchVenues(["--bad"], h.deps)).rejects.toThrow(
    "unknown argument",
  );
});
