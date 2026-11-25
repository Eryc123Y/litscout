import { createMcpHandler } from "agents/mcp/server";
import { beforeEach, expect, it, vi } from "vitest";
import { buildServer } from "../src/server";
import { workerEnv } from "@litscout/worker/test/helpers/worker-env";
import { publicSourceFixtures } from "./helpers/public-sources";
import { clearMemoryCache } from "@litscout/sources/http/cache";
import venues from "@litscout/core/test/fixtures/venues.json";
const { env, ctx, kv } = workerEnv();
beforeEach(() => clearMemoryCache());
async function call(name: string, args: unknown) {
  const response = await createMcpHandler(() => buildServer(env), {
    route: "/mcp",
  })(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: {
        host: "worker.example",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  const body = await response.text();
  const data = body.startsWith("{")
    ? body
    : body
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5);
  const result = JSON.parse(data).result as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { result, data: JSON.parse(result.content[0]!.text) };
}
it.each([
  ["search", { query: "synthetic" }],
  ["get_paper", { ids: "10.1234/test" }],
  ["paper_links", { id: "CorpusId:1", direction: "citations" }],
  ["get_author", { name_or_id: "Alex Example", include_papers: true }],
  ["coauthorship", { author_a: "Alex Example", author_b: "Sam Example" }],
  ["reviews", { query: "syntheticForum" }],
  ["venue", { query: "SSW" }],
])(
  "executes the %s tool over the real MCP transport with provenance",
  async (name, args) => {
    kv.set("litscout:venues", JSON.stringify(venues));
    vi.stubGlobal("fetch", publicSourceFixtures().fetch);
    const { result, data } = await call(name as string, args);
    expect(result.isError).not.toBe(true);
    expect(data.sources_used.length).toBeGreaterThan(0);
    expect(data.sources_skipped).toEqual(expect.any(Array));
    if (name === "get_author")
      expect(data.result).toContain("0000-0000-0000-0001");
  },
);
it("finds papers shared by three authors", async () => {
  vi.stubGlobal("fetch", publicSourceFixtures().fetch);
  const { result, data } = await call("coauthorship", {
    authors: ["Alex Example", "Sam Example", "Robin Example"],
  });
  expect(result.isError).not.toBe(true);
  expect(data.result).toContain("A shared synthetic paper");
});
it("reports missing venue data and failed reviews without false success", async () => {
  kv.delete("litscout:venues");
  const v = await call("venue", { query: "SSW" });
  expect(v.data.sources_skipped[0].source).toBe("venue_table");
  vi.stubGlobal(
    "fetch",
    async () => new Response("upstream secret response", { status: 403 }),
  );
  const r = await call("reviews", { query: "syntheticForum" });
  expect(r.result.isError).toBe(true);
  expect(r.data.sources_skipped[0]).toEqual({
    source: "openreview",
    reason: "HTTP 403",
  });
  expect(JSON.stringify(r)).not.toContain("upstream secret response");
});
