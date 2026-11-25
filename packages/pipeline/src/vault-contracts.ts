import { z } from "zod";

export const vaultHash = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
export const vaultPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !/[\\:\x00-\x1f\x7f]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Expected a vault-relative path",
  );
export const vaultKinds = [
  "project",
  "idea",
  "working_paper",
  "paper_note",
  "brief",
] as const;
export const ideaStatus = z.enum([
  "seed",
  "exploring",
  "in-paper",
  "parked",
  "dropped",
]);
const label = z.string().min(1).max(512);
/** A note body shown read-only on the web (vault.uploadBodies). */
export const noteBodyLimit = 32_000;
const noteBody = z.string().min(1).max(noteBodyLimit).optional();
/** A capture's Markdown body: a note written on the web or by an agent. */
const captureBody = z.string().max(10_000);
const optionalText = z.string().max(1500).optional();
const refs = z.array(label).max(100).optional();
const baseNote = {
  id: vaultHash,
  path: vaultPath,
  title: label,
  hash: vaultHash,
  bodyHash: vaultHash,
};
export const vaultNote = z.discriminatedUnion("kind", [
  z.strictObject({
    ...baseNote,
    kind: z.literal("project"),
    body: noteBody,
    frontmatter: z.strictObject({
      status: optionalText,
      description: optionalText,
    }),
  }),
  z.strictObject({
    ...baseNote,
    kind: z.literal("idea"),
    body: noteBody,
    frontmatter: z.strictObject({
      status: optionalText,
      description: optionalText,
      project: optionalText,
      papers: refs,
    }),
  }),
  z.strictObject({
    ...baseNote,
    kind: z.literal("working_paper"),
    body: noteBody,
    frontmatter: z.strictObject({
      status: optionalText,
      ideas: refs,
      papers: refs,
      project: optionalText,
    }),
  }),
  z.strictObject({
    ...baseNote,
    kind: z.literal("paper_note"),
    frontmatter: z.strictObject({
      arxiv: label.optional(),
      doi: label.optional(),
      maturity: optionalText,
    }),
  }),
  z.strictObject({
    ...baseNote,
    kind: z.literal("brief"),
    frontmatter: z.strictObject({}),
  }),
]);
export type VaultNote = z.output<typeof vaultNote>;

export const indexBatchSize = 12;
export const titleKeyBatchSize = 48;
/** Pending title keys are counted up to this many per table, to bound the read. */
export const titleKeyCountCap = 10_000;
export const indexLimit = 1000;
const maxBatches = Math.ceil((2 * indexLimit) / indexBatchSize);
export const indexBatch = z.strictObject({
  snapshot: vaultHash,
  previous: vaultHash.nullable(),
  part: z
    .number()
    .int()
    .min(0)
    .max(maxBatches - 1),
  notes: z.array(vaultNote).max(indexBatchSize),
  removed: z.array(vaultHash).max(indexBatchSize).default([]),
});
export const indexCommit = z.strictObject({
  snapshot: vaultHash,
  previous: vaultHash.nullable(),
  parts: z.number().int().min(1).max(maxBatches),
  count: z.number().int().min(0).max(indexLimit),
  changes: z
    .number()
    .int()
    .min(0)
    .max(indexLimit * 2),
});
export const indexHead = z.strictObject({
  snapshot: vaultHash.nullable(),
  count: z.number().int().nonnegative(),
  titleKeysPending: z.boolean().optional(),
  /** Rows still to key, capped per table; absent from older Workers. */
  titleKeysPendingCount: z.number().int().nonnegative().optional(),
});
export const indexTitleBackfill = z.strictObject({
  backfillTitleKeys: z.literal(true),
});
export const indexTitleBackfillReply = z.strictObject({
  titleKeysPending: z.boolean(),
});
export const indexIds = z.object({
  snapshot: vaultHash.nullable(),
  items: z.array(z.object({ id: vaultHash, fingerprint: vaultHash })),
  next: vaultHash.nullable(),
});

export const vaultRequestKind = z.enum([
  "capture",
  "link_paper",
  "set_status",
  "add_reading",
  "make_paper_note",
]);
const recordId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const newVaultRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capture"),
    title: label,
    body: captureBody.optional(),
    paperId: recordId.optional(),
  }),
  z.strictObject({
    kind: z.literal("link_paper"),
    targetNoteId: vaultHash,
    paperId: recordId,
  }),
  z.strictObject({
    kind: z.literal("set_status"),
    targetNoteId: vaultHash,
    status: ideaStatus,
  }),
  z.strictObject({
    kind: z.literal("add_reading"),
    targetNoteId: vaultHash,
    paperId: recordId,
  }),
  z.strictObject({
    kind: z.literal("make_paper_note"),
    paperId: recordId,
    topic: label.optional(),
  }),
]);
export type NewVaultRequest = z.output<typeof newVaultRequest>;

const webUrl = z.url({ protocol: /^https?$/ });
export const vaultPaper = z.object({
  id: recordId,
  title: z.string(),
  arxiv: z.string().optional(),
  doi: z.string().optional(),
  url: webUrl.optional(),
  topics: z.array(z.string()),
  links: z.array(z.object({ kind: z.string(), url: webUrl })),
  summary: z
    .object({
      tldr: z.string(),
      motivation: z.string(),
      method: z.string(),
      result: z.string(),
      conclusion: z.string(),
    })
    .optional(),
  notes: z.array(z.string()),
});
export type VaultPaper = z.output<typeof vaultPaper>;
export const captureReference = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), title: label, path: vaultPath }),
  z.object({
    kind: z.literal("paper"),
    title: z.string(),
    url: webUrl.optional(),
  }),
]);
export const captureEdit = z.strictObject({
  title: label.trim().min(1),
  body: captureBody.default(""),
});
export const pendingCapture = z.object({
  id: recordId,
  title: label,
  body: z.string(),
  paperTitle: z.string().nullable(),
  applying: z.boolean(),
});
export const vaultClaimReply = z.object({
  claimed: z.boolean(),
  capture: z.object({ title: label, body: captureBody }).optional(),
});
const target = z.object({ id: vaultHash, path: vaultPath });
const request = { id: recordId };
export const queuedVaultRequest = z.discriminatedUnion("kind", [
  z.object({
    ...request,
    kind: z.literal("capture"),
    title: label,
    body: captureBody.optional(),
    paper: vaultPaper.optional(),
    references: z.array(captureReference).max(15).optional(),
  }),
  z.object({
    ...request,
    kind: z.literal("link_paper"),
    target,
    baseHash: vaultHash,
    paper: vaultPaper.optional(),
  }),
  z.object({
    ...request,
    kind: z.literal("set_status"),
    target,
    baseHash: vaultHash,
    resultHash: vaultHash.optional(),
    status: ideaStatus,
  }),
  z.object({
    ...request,
    kind: z.literal("add_reading"),
    target,
    baseHash: vaultHash,
    paper: vaultPaper.optional(),
  }),
  z.object({
    ...request,
    kind: z.literal("make_paper_note"),
    paper: vaultPaper.optional(),
    topic: label.optional(),
  }),
]);
export type CaptureReference = z.output<typeof captureReference>;
export type QueuedVaultRequest = z.output<typeof queuedVaultRequest>;
export const resolveVaultRequest = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("applied"), claim: z.uuid().optional() }),
  z.strictObject({
    state: z.literal("rejected"),
    reason: z.string().min(1).max(1100),
    claim: z.uuid().optional(),
  }),
]);
export const vaultClaim = z.strictObject({
  claim: z.uuid(),
  resultHash: vaultHash.optional(),
});

const count = z.number().int().nonnegative();
const conventionTags = {
  ideaTag: z.string().min(1),
  workingPaperTag: z.string().min(1),
};
export const vaultConventionSettings = z.strictObject({
  ...conventionTags,
  projects: z.array(z.string()),
  /** The vault conventions guide (config vault.guideUrl). */
  guideUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .optional(),
});
export const conventionPathLimit = 50;
const syncConventions = z.strictObject({
  ...conventionTags,
  ideaNotes: count,
  workingPaperNotes: count,
  paperNotesWithoutIdentifiers: z
    .strictObject({
      count,
      paths: z.array(vaultPath).max(conventionPathLimit),
    })
    .refine(({ count, paths }) => count >= paths.length),
  possibleNonProjects: count,
  excludedFolders: count.optional(),
  excludedNotes: count,
  privateNotes: count,
  /** Notes skipped because their frontmatter holds template placeholders. */
  templates: z
    .strictObject({
      count,
      paths: z.array(vaultPath).max(conventionPathLimit),
    })
    .refine(({ count, paths }) => count >= paths.length)
    .optional(),
});
export type SyncConventions = z.output<typeof syncConventions>;
export const vaultCounts = z.object(
  Object.fromEntries(vaultKinds.map((key) => [key, count])) as Record<
    (typeof vaultKinds)[number],
    typeof count
  >,
);
const writeKind = z.enum([
  "capture",
  "link_paper",
  "set_status",
  "add_reading",
  "make_paper_note",
  "block",
  "digest",
]);
// A diagnostic can name a file whose characters make it invalid as a vault path.
export const vaultIssue = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\p{Cc}]+$/u),
  reason: z.string().max(300),
});
export type VaultIssue = z.output<typeof vaultIssue>;
export const syncReport = z.strictObject({
  writeEnabled: z.boolean(),
  counts: vaultCounts,
  excludedFolders: count.optional(),
  excludedNotes: count.optional(),
  conventions: syncConventions.optional(),
  writes: z
    .array(
      z.strictObject({
        kind: writeKind,
        path: vaultPath,
        mode: z.enum(["planned", "applied"]),
      }),
    )
    .max(1200),
  handEdited: z.array(vaultPath).max(1200),
  issues: z.array(vaultIssue).max(1200),
});
export type SyncReport = z.output<typeof syncReport>;
export const vaultStatus = z.object({
  last: syncReport.extend({ at: z.iso.datetime() }).nullable(),
  conventionSettings: vaultConventionSettings.optional(),
  queued: z.array(
    z.object({
      id: recordId,
      kind: vaultRequestKind,
      title: z.string(),
      path: vaultPath.nullable(),
      createdAt: z.string(),
      applying: z.boolean(),
    }),
  ),
  rejected: z.array(
    z.object({
      id: recordId,
      kind: vaultRequestKind,
      title: z.string(),
      reason: z.string(),
      resolvedAt: z.string(),
    }),
  ),
  queuedCount: count,
});
export const vaultPaperNote = z.object({
  path: vaultPath.nullable(),
  pending: z.boolean(),
  notesWithoutIdentifiers: count.optional(),
  matchedBy: z.literal("title").optional(),
  capturePending: z.boolean().optional(),
  linkPending: z.boolean().optional(),
});
/** A project, idea or draft note as the web shows it read-only: bodyMd is
 * null unless the owner uploads bodies (vault.uploadBodies). */
export const vaultNoteView = z.object({
  id: vaultHash,
  kind: z.enum(["project", "idea", "working_paper"]),
  title: label,
  path: vaultPath,
  bodyMd: z.string().max(noteBodyLimit).nullable(),
});
export type VaultNoteView = z.output<typeof vaultNoteView>;

export const vaultIdea = z.object({
  id: vaultHash,
  title: label,
  path: vaultPath,
  status: z.string().nullable(),
  description: z.string().nullable(),
  projectId: vaultHash.nullable(),
  paperIds: z.array(recordId),
  projectTitle: z.string().nullable().optional(),
  statusRequest: z
    .object({
      id: recordId,
      state: z.enum(["queued", "rejected"]),
      status: ideaStatus,
      reason: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export const vaultProject = z.object({
  id: vaultHash,
  title: label,
  path: vaultPath,
  status: z.string(),
  summary: z.string().nullable(),
  ideas: z.array(vaultIdea.pick({ id: true, title: true, path: true })),
  papers: z.array(z.object({ id: recordId, title: z.string() })),
  radar: z.array(
    z.object({
      id: recordId,
      paperId: recordId,
      title: z.string(),
      day: z.iso.date(),
      level: z.string(),
      reason: z.string(),
    }),
  ),
});

export const vaultId = recordId;
export const vaultMatch = z.strictObject({
  id: vaultHash,
  arxiv: label.optional(),
  doi: label.optional(),
  title: label.optional(),
});
export const vaultMatchResult = z.object({
  id: vaultHash,
  paperId: vaultId,
  matchedBy: z.literal("title").optional(),
});
export const vaultDigest = z.object({
  day: z.iso.date(),
  markdown: z.string(),
});
export const queuedReply = z.object({
  id: vaultId,
  state: z.literal("queued"),
});
const cursor = vaultHash.nullable();
export const ideasPage = z.object({ items: z.array(vaultIdea), next: cursor });
export const projectsPage = z.object({
  items: z.array(vaultProject),
  next: cursor,
});

/** Body handling, authorization and budgeting share the vault write routes. */
export function vaultWriteReservation(path: string, body: unknown) {
  if (path === "/vault/index") {
    if (indexTitleBackfill.safeParse(body).success)
      return 4 * titleKeyBatchSize + 4;
    const commit = indexCommit.safeParse(body);
    if (commit.success)
      return (
        12 * commit.data.changes + 6 * commit.data.count + commit.data.parts + 4
      );
    return 4;
  }
  if (path === "/vault/report") return 4;
  if (/^\/suggestions\/[\w-]+\/(?:accept|dismiss)$/.test(path)) return 12;
  if (/^\/vault\/requests(?:\/[\w-]+(?:\/(?:claim|resolve))?)?$/.test(path))
    return 12;
  return 0;
}

export const syncStage = z.enum(["index", "requests", "blocks", "digests"]);
