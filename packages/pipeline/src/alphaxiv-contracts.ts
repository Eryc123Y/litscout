import { z } from "zod";
import { INGEST_CAPS } from "@litscout/core/ingest-limits";

export const mirrorPath = "/ingest/alphaxiv";
export const mirrorBatchCap = INGEST_CAPS.papers;
export const mirrorFolderCap = 200;
export const folderId = z.uuid().transform((id) => id.toLowerCase());
export const mirrorFolderKey = z.union([folderId, z.string().min(1).max(5000)]);
const modernArxiv = /^(\d{2}(?:0[1-9]|1[0-2])\.\d{4,5})(?:v\d+)?$/i;
const legacyArxiv = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i;
export const arxivId = z
  .string()
  .max(64)
  .regex(
    /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i,
  )
  .transform((id) =>
    (modernArxiv.exec(id) ?? legacyArxiv.exec(id))![1]!.toLowerCase(),
  );
export const uploadId = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const mirrorTitle = z.string().trim().min(1).max(1000);
export const mirrorTime = z.iso
  .datetime({ offset: true })
  .max(40)
  .transform((time) => new Date(time).toISOString());
export const folderType = z.enum([
  "custom",
  "private-papers",
  "default-to-read",
  "default-reading",
  "default-completed",
  "default-publications",
]);
const status = z.enum(["saved", "reading", "read"]);
export const mirrorAnnotation = z.strictObject({
  highlightCount: z.number().int().min(0).max(1_000_000),
  hasNotes: z.boolean(),
  lastAnnotatedAt: mirrorTime,
});
export const mirrorFolder = z.strictObject({
  id: mirrorFolderKey,
  path: z.string().min(1).max(5000),
  type: folderType,
});
export const mirrorFolderLabel = mirrorFolder.pick({ id: true, path: true });

const item = z.strictObject({
  title: mirrorTitle,
  folders: z.array(mirrorFolder).max(mirrorFolderCap),
  status,
});
const publicItem = item.extend({
  paperType: z.literal("public"),
  paperId: arxivId,
  publicationDate: z.iso.date().nullable(),
  annotation: mirrorAnnotation.omit({ lastAnnotatedAt: true }).nullable(),
});
const privateItem = item.extend({
  paperType: z.literal("private"),
  paperId: uploadId,
});
export const mirrorItem = z.discriminatedUnion("paperType", [
  publicItem,
  privateItem,
]);
export type MirrorItem = z.output<typeof mirrorItem>;
export type MirrorFolder = z.output<typeof mirrorFolder>;

export const arxivMetadata = z.strictObject({
  title: mirrorTitle,
  authors: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(300) }))
    .max(200),
  abstract: z.string().max(20000).optional(),
  publicationDate: z.iso.date().optional(),
});
export const mirrorRun = z.strictObject({
  takenAt: mirrorTime,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MirrorRun = z.output<typeof mirrorRun>;
const writeItem = z.discriminatedUnion("paperType", [
  publicItem.extend({ metadata: arxivMetadata.optional() }),
  privateItem,
]);
export const mirrorWrite = mirrorRun.extend({
  items: z.array(writeItem).min(1).max(mirrorBatchCap),
});
export type MirrorWrite = z.output<typeof mirrorWrite>;

export const mirrorState = z.strictObject({
  items: z.array(mirrorItem).max(50),
  pendingMetadata: z.array(arxivId).max(50).default([]),
  nextCursor: z.string().max(136).nullable(),
  active: mirrorRun.nullable(),
  completed: mirrorRun.nullable(),
});
export const mirrorStateQuery = z.object({
  after: z.string().max(136).default(""),
});
export const knownArxivQuery = z.array(arxivId).min(1).max(50);
export const knownArxivResult = z.array(arxivId).max(50);

export function alphaXivUrl(id: string, type: "public" | "private") {
  return (
    "https://www.alphaxiv.org/" +
    (type === "private" ? "private/" : "abs/") +
    id.split("/").map(encodeURIComponent).join("/")
  );
}
