import { expect, it } from "vitest";
import { defineConfig } from "../src/config";
it("F1 supplies Free ingest defaults and validates every override against server caps", () => {
  expect(defineConfig({}).instance.limits.ingest).toEqual({
    papers: 5,
    summaries: 20,
    legacy: 20,
    radar: 20,
    bytes: 262144,
  });
  for (const [key, cap] of Object.entries({
    papers: 40,
    summaries: 50,
    legacy: 40,
    radar: 40,
    bytes: 524288,
  })) {
    expect(() =>
      defineConfig({ instance: { limits: { ingest: { [key]: cap } } } }),
    ).not.toThrow();
    for (const invalid of [0, cap + 1, 1.5])
      expect(() =>
        defineConfig({ instance: { limits: { ingest: { [key]: invalid } } } }),
      ).toThrow();
  }
});
