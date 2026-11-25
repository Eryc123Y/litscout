import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { defineConfig } from "@litscout/core";
import { topVenueNames } from "../src/venue-crawl";
import { webVars } from "../src/web-vars";

it("publishes the watchlist's top venues in the instance settings", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-top-"));
  const file = path.join(dir, "venues.json");
  writeFileSync(
    file,
    JSON.stringify({
      venues: [
        { name: "CVPR", kind: "conference", top: true },
        { name: "Workshop", kind: "conference" },
        { name: "IEEE TPAMI", kind: "journal", top: true },
      ],
    }),
  );
  const top = await topVenueNames(file);
  expect(top).toEqual(["CVPR", "IEEE TPAMI"]);
  const config = defineConfig({ instance: { name: "t" } });
  expect(JSON.parse(webVars(config, top).INSTANCE_CONFIG).topVenues).toEqual(
    top,
  );
  expect(JSON.parse(webVars(config).INSTANCE_CONFIG)).not.toHaveProperty(
    "topVenues",
  );
  expect(await topVenueNames(path.join(dir, "missing.json"))).toEqual([]);
});
