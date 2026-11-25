import {
  mockFetch,
  json,
  isS2,
  isOA,
} from "@litscout/core/test/helpers/mock-fetch";
import reviews from "@litscout/core/test/fixtures/openreview.json";
export function publicSourceFixtures() {
  const paper = {
    paperId: "test",
    corpusId: 1,
    title: "A shared synthetic paper",
    year: 2024,
    abstract: "Evidence",
    externalIds: { DOI: "10.1234/test" },
    authors: [
      { name: "Alex Example", authorId: "11" },
      { name: "Sam Example", authorId: "22" },
      { name: "Robin Example", authorId: "33" },
    ],
  };
  return mockFetch([
    {
      match: isS2("/paper/search"),
      respond: () => json({ data: [paper], total: 1 }),
    },
    { match: isS2("/paper/batch"), respond: () => json([paper]) },
    {
      match: isS2("/paper/CorpusId%3A1/citations"),
      respond: () => json({ data: [{ citingPaper: paper }], next: 10 }),
    },
    {
      match: isS2("/author/search"),
      respond: (u) =>
        json({
          data: [
            {
              authorId: u.searchParams.get("query")?.startsWith("Sam")
                ? "22"
                : u.searchParams.get("query")?.startsWith("Robin")
                  ? "33"
                  : "11",
              name: u.searchParams.get("query"),
              affiliations: ["Example University"],
              externalIds: { ORCID: "0000-0000-0000-0001" },
              papers: [paper],
            },
          ],
        }),
    },
    { match: isOA("/works"), respond: () => json({ results: [] }) },
    { match: isOA("/authors"), respond: () => json({ results: [] }) },
    {
      match: (u) => u.hostname === "api2.openreview.net",
      respond: () => json(reviews),
    },
  ]);
}
