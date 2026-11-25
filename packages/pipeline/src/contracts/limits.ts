import { z } from "zod";
const scalar = z.union([
  z.string().max(5000),
  z.number(),
  z.boolean(),
  z.null(),
]);
function jsonValue(depth: number): z.ZodType<unknown> {
  if (!depth) return scalar;
  const child = jsonValue(depth - 1);
  return z.union([
    scalar,
    z.array(child).max(1000),
    z.record(z.string().max(128), child),
  ]);
}
export const boundedJson = jsonValue(4);
export function normaliseHttpUrl(value: string) {
  return value.replace(
    /[()\s<>\[\]\\'"`{}\u0000-\u001f\u007f]/g,
    (character) => {
      const encoded = encodeURIComponent(character);
      return encoded === character
        ? "%" +
            character.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()
        : encoded;
    },
  );
}
export const httpUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https?:\/\//i)
  .transform(normaliseHttpUrl)
  .pipe(z.url().max(2048));
export const cursorNameSchema = z.union([
  z.literal("venue-feed"),
  z.literal("arxiv-listing"),
  z
    .string()
    .max(19)
    .regex(/^fulltext:\d{4}-\d{2}-\d{2}$/),
  z
    .string()
    .max(39)
    .regex(/^legacy:[a-f0-9]{32}$/),
]);
export const listingCursorSchema = z.strictObject({
  listingDate: z.iso.date().max(10),
  runDay: z.iso.date().max(10),
  noAnnouncement: z.array(z.iso.date().max(10)).max(60).optional(),
  pendingDays: z.array(z.iso.date().max(10)).max(60).optional(),
});
export const legacyCursorSchema = z.strictObject({
  offset: z.number().int().min(0).max(1000000),
  runId: z.string().max(128).startsWith("run_").optional(),
  version: z.literal(2).optional(),
});
export const cursorValueSchema = z
  .strictObject({ name: cursorNameSchema, value: z.string().max(2048) })
  .superRefine((value, ctx) => {
    try {
      const raw: unknown = JSON.parse(value.value);
      const schema =
        value.name === "venue-feed"
          ? z.strictObject({ since: z.iso.date().max(10) })
          : value.name === "arxiv-listing"
            ? listingCursorSchema
            : value.name.startsWith("fulltext:")
              ? z.array(z.string().max(128).startsWith("pap_")).max(2)
              : legacyCursorSchema;
      if (!schema.safeParse(raw).success) throw new Error("Invalid cursor");
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Cursor must contain only its small operational state",
      });
    }
  });
