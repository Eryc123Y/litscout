import { z } from "zod";
import { digestSuggestionLimit } from "@litscout/core/ingest-limits";
import { libraryStatus } from "./library-contracts";
import { vaultHash, vaultId, vaultIdea, vaultPath } from "./vault-contracts";

export const researchPageSize = 25;
export function researchPage<T extends { id: string }>(items: T[]) {
  return {
    items: items.slice(0, researchPageSize),
    next:
      items.length > researchPageSize ? items[researchPageSize - 1]!.id : null,
  };
}

export const workingPaper = z.object({
  id: vaultHash,
  title: z.string(),
  path: vaultPath,
  status: z.string().nullable(),
  projectTitle: z.string().nullable(),
});
export const workingPapersPage = z.object({
  items: z.array(workingPaper),
  next: vaultHash.nullable(),
});
const paper = z.object({
  id: vaultId,
  title: z.string(),
  pending: z.boolean(),
});
export const workingPaperDetail = workingPaper.extend({
  ideas: z.array(vaultIdea.pick({ id: true, title: true, path: true })),
  reading: z.array(
    paper.extend({
      status: libraryStatus.nullable(),
      vaultPath: vaultPath.nullable(),
      ideaIds: z.array(vaultHash),
    }),
  ),
  readingMore: z.number().int().nonnegative().default(0),
  recent: z.array(
    paper.extend({
      day: z.iso.date(),
      source: z.string(),
      topics: z.array(z.string()),
    }),
  ),
});

export const suggestionLimit = digestSuggestionLimit;
export const suggestionKind = z.enum([
  "combination",
  "new_idea",
  "paper_for_idea",
]);
export const suggestionStatus = z.enum(["new", "accepted", "dismissed"]);
const suggestionFields = {
  title: z.string().trim().min(1).max(512),
  bodyMd: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= 4096,
      "Suggestion body must be at most 4 KiB of UTF-8",
    ),
  projectIds: z.array(vaultHash).max(5),
};
export const suggestedIdea = z.discriminatedUnion("kind", [
  z.strictObject({
    ...suggestionFields,
    kind: z.literal("combination"),
    ideaIds: z
      .array(vaultHash)
      .min(2)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
    paperIds: z.array(vaultId).max(5),
  }),
  z.strictObject({
    ...suggestionFields,
    kind: z.literal("new_idea"),
    ideaIds: z.tuple([]),
    paperIds: z.array(vaultId).min(1).max(5),
  }),
  z.strictObject({
    ...suggestionFields,
    kind: z.literal("paper_for_idea"),
    ideaIds: z.tuple([vaultHash]),
    paperIds: z.tuple([vaultId]),
  }),
]);
const reference = z.object({ id: vaultId, title: z.string() });
export const suggestion = z.object({
  ...suggestionFields,
  kind: suggestionKind,
  ideaIds: z.array(vaultHash),
  paperIds: z.array(vaultId),
  id: vaultId,
  day: z.iso.date(),
  status: suggestionStatus,
  resolvedAt: z.string().nullable(),
  requestId: vaultId.nullable(),
  requestState: z
    .enum(["queued", "applied", "rejected", "cancelled"])
    .nullable(),
  references: z
    .object({
      ideas: z.array(reference),
      papers: z.array(reference),
      projects: z.array(reference),
    })
    .optional(),
});
export const suggestionsPage = z.object({
  items: z.array(suggestion),
  next: vaultId.nullable(),
});
export const suggestionsQuery = z.object({
  day: z.iso.date().optional(),
  status: suggestionStatus.optional(),
  after: vaultId.optional(),
});
export const suggestionAction = z.enum(["accept", "dismiss"]);
export const suggestionResolution = z.object({
  status: z.enum(["accepted", "dismissed"]),
  requestId: vaultId.nullable(),
});
export const vaultInfo = z.object({ name: z.string().min(1).max(255) });
export type SuggestedIdea = z.output<typeof suggestedIdea>;
