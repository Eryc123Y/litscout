import {
  webFeedSchema,
  webDaysSchema,
  webPaperSchema,
} from "@litscout/pipeline/web-contracts";
import { publicPaper } from "../src/public-shape";
import { expect, it } from "vitest";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
import { publicFeed, publicDays, instanceInfo } from "../src/public-feed";
const privateItem = {
  paperId: "pap_test",
  title: "Public title",
  abstract: "Abstract",
  authors: [{ name: "Author" }],
  authorCount: 1,
  tldr: [{ lang: "en", text: "t", privateNote: "PRIVATE" }],
  year: null,
  publishedOn: null,
  categories: [],
  source: "arxiv",
  topics: ["Vision"],
  shortlisted: true,
  summaries: [],
  identifiers: [],
  links: [],
  state: { rating: "up" },
  notes: "PRIVATE_NOTE",
  library: true,
  ideas: ["PRIVATE_IDEA"],
  profile: "PRIVATE_PROFILE",
  userId: "PRIVATE_OWNER",
  radarBrief: "PRIVATE_BRIEF",
  hfUpvotes: 12,
  venue: "Venue",
  venueKind: "conference",
};
it("projects only explicit public fields, including nested objects", () => {
  const data = publicFeed({
    day: "2026-11-17",
    status: "final",
    counts: {
      total: 1,
      arxiv: 1,
      venues: 0,
      summarised: 1,
      shortlisted: 1,
      topics: { Vision: 1 },
      sources: { arxiv: 1 },
      venueCounts: { Venue: 1 },
      PRIVATE: 9,
    },
    nextCursor: null,
    items: [
      {
        ...privateItem,
        authors: [{ name: "Author", notes: "PRIVATE" }],
        summaries: [
          {
            paperId: "pap_test",
            lang: "en",
            content: {
              tldr: "t",
              motivation: "m",
              method: "m",
              result: "r",
              conclusion: "c",
            },
            client: "PRIVATE_CLIENT",
          },
        ],
        links: [
          { kind: "landing", url: "https://example.org", note: "PRIVATE_LINK" },
        ],
      },
    ],
  });
  expect(webFeedSchema.safeParse(data).success).toBe(true);
  expect(JSON.stringify(data)).not.toContain("PRIVATE");
  expect(data.items[0]).toMatchObject({
    paperId: "pap_test",
    authorCount: 1,
    tldr: [{ lang: "en", text: "t" }],
  });
  for (const key of ["abstract", "summaries", "links", "readingState"])
    expect(data.items[0]).not.toHaveProperty(key);
  expect(
    publicDays([
      {
        day: "2026-11-17",
        status: "pending",
        counts: {},
        privateNote: "PRIVATE",
      },
    ]),
  ).toEqual([
    { day: "2026-11-17", status: "pending", counts: { total: 0, sources: {} } },
  ]);
});
it("public setting fails closed, has no private instance config and needs no Access", async () => {
  const { env } = workerEnv();
  expect(instanceInfo(env).publicFeed).toBe(false);
  expect((await app.request("/api/v1/public/days", {}, env)).status).toBe(404);
  const info = await app.request("/api/v1/instance", {}, env);
  expect(info.status).toBe(200);
  expect(await info.json()).toEqual({
    success: true,
    data: { name: "LitScout" },
  });
  expect(
    (
      await app.request(
        "/api/v1/public/days",
        {},
        { ...env, PUBLIC_FEED: "true" },
      )
    ).status,
  ).toBe(503);
});
it("invalid optional display config falls back and cannot override the public switch", () => {
  const { env } = workerEnv();
  expect(
    instanceInfo({ ...env, PUBLIC_FEED: "true", INSTANCE_CONFIG: "bad" }),
  ).toMatchObject({ publicFeed: true, name: "LitScout" });
  expect(
    instanceInfo({ ...env, INSTANCE_CONFIG: '{"name":42}' }),
  ).toMatchObject({ publicFeed: false, name: "LitScout" });
  expect(
    instanceInfo({
      ...env,
      INSTANCE_CONFIG: '{"publicFeed":true,"name":"Reader"}',
    }),
  ).toMatchObject({ publicFeed: false, name: "Reader" });
});

it("H1 projects full public records without private nested fields and validates them only in tests", () => {
  const data = publicPaper({
    ...privateItem,
    summaries: [
      {
        lang: "en",
        client: "PRIVATE_CLIENT",
        content: {
          tldr: "T",
          motivation: "M",
          method: "M",
          result: "R",
          conclusion: "C",
          privateNote: "PRIVATE_NOTE",
        },
      },
    ],
  });
  expect(webPaperSchema.safeParse(data).success).toBe(true);
  expect(JSON.stringify(data)).not.toContain("PRIVATE");
  expect(
    webDaysSchema.safeParse(
      publicDays([
        {
          day: "2026-11-17",
          status: "pending",
          counts: { total: 1, sources: { arxiv: 1 } },
          privateNote: "PRIVATE",
        },
      ]),
    ).success,
  ).toBe(true);
});
