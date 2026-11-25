import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

// The old LitScout Daily site's page addresses (H0). Its hash links are
// mapped in the web app (apps/web/src/model.ts legacyRoute); these are the
// paths and query strings the Worker sees.
let close: () => Promise<void>;
let env: ReturnType<typeof workerEnv>["env"];
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  const db = h.db.$client as unknown as D1Database;
  env = { ...workerEnv().env, DB: db, LOCAL_DEV: "true", PUBLIC_FEED: "true" };
  await db
    .prepare(
      "INSERT INTO feed_days(day,status) VALUES ('2026-11-20','final'), ('2026-11-23','digested'), ('2026-11-24','pending')",
    )
    .run();
});
afterAll(() => close());
const location = async (path: string) => {
  const response = await app.request(path, { redirect: "manual" }, env);
  return { status: response.status, to: response.headers.get("location") };
};

it("sends the old index page to the reader, keeping its query", async () => {
  expect(await location("/index.html")).toEqual({ status: 301, to: "/" });
  expect(await location("/index.html?x=1")).toEqual({
    status: 301,
    to: "/?x=1",
  });
});

it("sends the old keyword statistics page to Trends", async () => {
  // 302: the target may change once Trends has a public page.
  expect(await location("/statistic.html")).toEqual({
    status: 302,
    to: "/app/trends",
  });
});

it("sends the old JSON mode for scripts to the newest public day's JSON", async () => {
  // The newest day with papers, not a pending one; the first keyword of
  // three or more characters becomes the search.
  expect(await location("/?json=cs.CV&keywords=st,stereo,depth")).toEqual({
    status: 302,
    to: "/api/v1/public/days/2026-11-23?q=stereo",
  });
  for (const query of ["category=cs.LG", "author=Ada", "json=all"])
    expect(await location(`/?${query}`)).toEqual({
      status: 302,
      to: "/api/v1/public/days/2026-11-23",
    });
  const json = await app.request(
    "/api/v1/public/days/2026-11-23?q=stereo",
    {},
    env,
  );
  expect(json.status).toBe(200);
  expect(await json.json()).toMatchObject({ success: true });
});

it("serves the reader instead of the JSON mode when the feed is private", async () => {
  const response = await app.request(
    "/?json=cs.CV",
    { redirect: "manual" },
    { ...env, PUBLIC_FEED: "false" },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
});

it("serves the reader for a plain root, with or without other queries", async () => {
  for (const path of ["/", "/?utm=x"]) {
    const response = await app.request(path, { redirect: "manual" }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  }
});
