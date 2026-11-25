import { z } from "zod";

/** A yes/no filter from an address (`"true"`, `"false"`) or a tool call. */
export const booleanQuery = z
  .union([z.enum(["true", "false"]), z.boolean()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === "true"));
/** Venue type: arXiv and other preprints, conference or journal papers. A
 * paper without one counts as a preprint. The day pages, the Library and the
 * search share it, with `top` (only the instance's top venues). */
export const venueKindQuery = z.enum(["preprint", "conference", "journal"]);
