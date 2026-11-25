import { z } from "zod";

type Node = Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A tuple as a plain array of a fixed length: one form every checker reads. */
function plainArrays(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainArrays);
  if (!isNode(value)) return value;
  const tuple = Array.isArray(value.items) ? (value.items as unknown[]) : null;
  const rest = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !tuple || (key !== "items" && key !== "additionalItems"),
      )
      .map(([key, child]) => [key, plainArrays(child)]),
  );
  if (!tuple) return rest;
  const extra = value.additionalItems;
  const open = extra !== undefined && extra !== false;
  const members = open ? [...tuple, extra] : tuple;
  if (!members.length) return { ...rest, maxItems: 0 };
  return {
    ...rest,
    items: plainArrays(members.length === 1 ? members[0] : { anyOf: members }),
    minItems: tuple.length,
    ...(open ? {} : { maxItems: tuple.length }),
  };
}

/**
 * A JSON Schema for Claude Code's `--json-schema`: zod's draft-7 output
 * without `$schema`, tuples written as plain arrays with item counts. Claude
 * Code 2.1.330 checks the schema as strict draft-07 (no `prefixItems`, no
 * empty `items` array) and the API takes it as a 2020-12 tool input schema
 * (no array-valued `items`); only this form passes both (2026-11-22).
 */
export function structuredSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Node;
  return JSON.stringify(
    plainArrays(
      Object.fromEntries(
        Object.entries(json).filter(([key]) => key !== "$schema"),
      ),
    ),
  );
}
