import { parseListing } from "@litscout/sources/listings";
import { boundedText } from "./resolution-http";
import type { AppEnv } from "./env";

const category = "cs.CV";
const pageSize = 10;
const stageTtl = 2 * 24 * 60 * 60;

/** Stage only the first slice. A partial listing cannot publish a feed day. */
export async function stageCronListing(env: AppEnv, at: number) {
  const stage = env.CRON_CRAWL_STAGE;
  if (!stage) throw new Error("Cron trial requires its own staging namespace");

  const response = await fetch(
    `https://arxiv.org/list/${category}/new?skip=0&show=${pageSize}`,
    {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "LitScout/0.1 (cron crawl trial)" },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`arXiv listing HTTP ${response.status}`);
  }
  const html = await boundedText(response, 64 * 1024);
  if (!html) throw new Error("Cron trial listing is empty or exceeds 64 KiB");
  const runDay = new Date(at).toISOString().slice(0, 10);
  const page = parseListing(html, category, "new", runDay);
  const listingTime = Date.parse(`${page.day} UTC`);
  const core = page.core;
  if (
    !Number.isFinite(listingTime) ||
    !core?.sections.length ||
    core.sections.some((section) => !section.valid) ||
    core.sections.reduce((sum, section) => sum + section.ids.length, 0) >
      pageSize
  )
    throw new Error(
      "Cron trial listing does not match the bounded page format",
    );
  const listingDay = new Date(listingTime).toISOString().slice(0, 10);
  if (listingDay > runDay)
    throw new Error("Cron trial listing is ahead of the scheduled date");

  await stage.put(
    `arxiv/${listingDay}/${category}/0`,
    JSON.stringify({
      listingDay,
      category,
      offset: 0,
      total: page.total,
      core,
    }),
    { expirationTtl: stageTtl },
  );
}
