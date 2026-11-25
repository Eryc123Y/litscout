import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { securityWorker } from "../test/helpers/security-worker";
import { publicSourceFixtures } from "@litscout/mcp/test/helpers/public-sources";
import venues from "@litscout/core/test/fixtures/venues.json";
import { seedScale } from "./scale-seed";

export async function scaleRuntime(label: string, newest: string) {
  if (!/^[\w-]+$/.test(label) || !/^\d{4}-\d{2}-\d{2}$/.test(newest))
    throw new Error("Expected a label and an ISO day");
  const path = resolve(".artifacts/m4i", label);
  const marker = resolve(path, "seed-day");
  const initialized = existsSync(marker);
  if (initialized && readFileSync(marker, "utf8") !== newest)
    throw new Error("Seed day changed. Use a fresh label.");
  if (!initialized) mkdirSync(path, { recursive: false });
  const sources = publicSourceFixtures();
  const local = await securityWorker({
    entryPoint:
      process.env.LITSCOUT_SCALE_WORKER ??
      "apps/worker/scripts/scale-worker.ts",
    persistence: {
      path,
      initialized,
      through: process.env.LITSCOUT_SCALE_MIGRATION,
    },
    bindings: {
      PUBLIC_URL: "https://local",
      PUBLIC_FEED: "true",
      INSTANCE_CONFIG: JSON.stringify({
        name: "Scale rehearsal",
        language: "en",
        timezone: "UTC",
        topics: ["stereo", "vision"],
      }),
      MCP_RESEARCH_TOOLS: "true",
    },
    outboundService: (request) => {
      const url = new URL(request.url);
      if (
        url.hostname === "api.openalex.org" &&
        decodeURIComponent(url.pathname).includes("10.1234/scale.45000")
      ) {
        return Response.json({
          id: "https://openalex.org/W123",
          doi: "https://doi.org/10.1234/scale.45000",
          display_name: "Archived stereo geometry",
          abstract_inverted_index: { Stereo: [0], geometry: [1] },
        });
      }
      return sources.fetch(request.url);
    },
  });
  try {
    if (!initialized) {
      const start = performance.now();
      await seedScale(local.db, newest);
      console.error(
        `Seeded ${label} in ${((performance.now() - start) / 1000).toFixed(1)} s`,
      );
      writeFileSync(marker, newest);
    }
    await (
      await local.worker.getKVNamespace("OAUTH_KV")
    ).put("litscout:venues", JSON.stringify(venues));
    await local.db
      .prepare("UPDATE api_tokens SET last_used_at=?")
      .bind(new Date().toISOString())
      .run();
    return local;
  } catch (error) {
    await local.worker.dispose();
    throw error;
  }
}
