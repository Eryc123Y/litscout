import { readFileSync } from "node:fs";

const scheduledTime = Date.parse("2026-11-17T02:00:00Z");
export const scheduledFixtureUrl = `http://local/cdn-cgi/local/scheduled?format=json&time=${scheduledTime}`;

export const recordedListing = readFileSync(
  "packages/sources/test/fixtures/listings/fresh_new_cs_CV.html",
  "utf8",
);

export function cappedCvListing(rows = 10) {
  const start = recordedListing.indexOf("<dl id='articles'>");
  const end = recordedListing.lastIndexOf("</dl>");
  const entries = [...recordedListing.matchAll(/<dt>[\s\S]*?<\/dd>/g)]
    .slice(0, rows)
    .map(([entry]) => entry)
    .join("");
  return (
    recordedListing.slice(0, start) +
    `<dl id='articles'><h3>New submissions (showing ${rows} of 72 entries)</h3>` +
    entries +
    recordedListing.slice(end)
  );
}
