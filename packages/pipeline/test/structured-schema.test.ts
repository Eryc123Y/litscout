import { expect, it } from "vitest";
import { z } from "zod";
import { structuredSchema } from "../src/structured-schema";
import { digestSchema } from "../src/contracts/index";

const nodes = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === "object"
      ? [
          value as Record<string, unknown>,
          ...Object.values(value).flatMap(nodes),
        ]
      : [];

it("writes the draft schema in a form Claude Code's check and the API both take", () => {
  const schema = JSON.parse(structuredSchema(digestSchema));
  expect(schema).not.toHaveProperty("$schema");
  expect(schema).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  const all = nodes(schema);
  // Claude Code 2.1.330 rejected prefixItems, an empty items array and
  // additionalItems; the API rejected an items array (2026-11-22).
  expect(all.filter((n) => "prefixItems" in n)).toEqual([]);
  expect(all.filter((n) => Array.isArray(n.items))).toEqual([]);
  expect(all.filter((n) => "additionalItems" in n)).toEqual([]);
  // The suggestion kinds that name exactly one idea or paper keep that count.
  expect(
    all.filter(
      (n) => n.type === "array" && n.minItems === 1 && n.maxItems === 1,
    ).length,
  ).toBeGreaterThan(0);
});

it("turns tuples into plain arrays of a fixed length", () => {
  const schema = JSON.parse(
    structuredSchema(
      z.strictObject({
        one: z.tuple([z.string()]),
        none: z.tuple([]),
        two: z.tuple([z.string(), z.number()]),
        open: z.tuple([z.string()], z.number()),
      }),
    ),
  );
  expect(schema.properties.one).toEqual({
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 1,
  });
  expect(schema.properties.none).toEqual({ type: "array", maxItems: 0 });
  expect(schema.properties.two).toEqual({
    type: "array",
    items: { anyOf: [{ type: "string" }, { type: "number" }] },
    minItems: 2,
    maxItems: 2,
  });
  expect(schema.properties.open).toEqual({
    type: "array",
    items: { anyOf: [{ type: "string" }, { type: "number" }] },
    minItems: 1,
  });
});
