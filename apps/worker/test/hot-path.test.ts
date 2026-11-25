import { afterEach, expect, it, vi } from "vitest";
import { app } from "../src/app";
import {
  hotBindings,
  hotRequest,
  benchHotPath,
} from "../scripts/bench-hot-path";
import {
  webFeedSchema,
  webDaysSchema,
  webPaperSchema,
} from "@litscout/pipeline/web-contracts";
afterEach(() => vi.restoreAllMocks());
it("H1 prepares the Hono route matcher during module initialization", () => {
  expect(app.router.name).not.toBe("SmartRouter");
});
it("H1 returns a JSON error if final serialization itself fails", async () => {
  const binding = hotBindings(),
    original = JSON.stringify;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(JSON, "stringify").mockImplementation((value) => {
    if (value?.data?.items?.length === 30)
      throw new TypeError("synthetic serialization failure");
    return original(value);
  });
  const response = await app.fetch(
    hotRequest("/feed/days/2026-11-16/full"),
    binding.env,
  );
  expect(response.status).toBe(500);
  expect(JSON.parse(await response.text())).toMatchObject({
    success: false,
    error: { code: "INTERNAL_ERROR" },
  });
});
it("H1 serializes a full page once including due token and budget metadata", async () => {
  const binding = hotBindings(true),
    parse = vi.spyOn(Response.prototype, "json"),
    stringify = vi.spyOn(JSON, "stringify");
  const response = await app.fetch(
    hotRequest("/feed/days/2026-11-16/full"),
    binding.env,
  );
  const body = JSON.parse(await response.text());
  expect(response.status).toBe(200);
  expect(body.meta).toMatchObject({ authRowsWritten: 1, budgetRowsWritten: 4 });
  expect(binding.stats.tokenLookups).toBe(1);
  expect(binding.stats.batches).toBeGreaterThan(0);
  expect(parse).not.toHaveBeenCalled();
  expect(
    stringify.mock.calls.filter(([value]) => value?.data?.items?.length === 30),
  ).toHaveLength(1);
});
it("H1 keeps outgoing Zod validation outside production public reads", async () => {
  const binding = hotBindings(),
    validators = [webFeedSchema, webDaysSchema, webPaperSchema].map((schema) =>
      schema.safeParse.bind(schema),
    ),
    spies = [webFeedSchema, webDaysSchema, webPaperSchema].flatMap((schema) => [
      vi.spyOn(schema, "parse"),
      vi.spyOn(schema, "safeParse"),
    ]);
  const paths = [
    "/public/days/2026-11-16",
    "/public/days?limit=100",
    "/public/papers/arxiv:2611.18340",
  ];
  for (const [i, path] of paths.entries()) {
    const response = await app.fetch(hotRequest(path), binding.env);
    expect(response.status).toBe(200);
    expect(validators[i]!(JSON.parse(await response.text()).data).success).toBe(
      true,
    );
  }
  expect(binding.stats.limiterCalls).toBe(3);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it("H1 end-to-end benchmark records first/warm requests and exercises bindings", async () => {
  const result = await benchHotPath(1);
  expect(result.results).toHaveLength(8);
  expect(result.results.every((r) => r.firstMs > 0 && r.warmMedianMs > 0)).toBe(
    true,
  );
  expect(result.results.some((r) => r.limiterCalls > 0)).toBe(true);
  expect(
    result.results
      .filter((r) => !r.path.startsWith("/public"))
      .every((r) => r.tokenLookups > 0),
  ).toBe(true);
  expect(result.results.find((r) => r.due)?.batches).toBeGreaterThan(0);
});
