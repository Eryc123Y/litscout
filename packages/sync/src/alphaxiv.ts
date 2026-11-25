import {
  arxivId,
  uploadId,
  folderId,
  folderType,
  mirrorTime,
  mirrorTitle,
  mirrorAnnotation,
  mirrorFolderCap,
  mirrorItem,
  type MirrorItem,
  type MirrorFolder,
} from "@litscout/pipeline/alphaxiv-contracts";
import { z } from "zod";

const date = z
  .union([z.iso.date(), mirrorTime.transform((time) => time.slice(0, 10))])
  .nullable();
const membership = z.strictObject({
  folderId,
  title: mirrorTitle,
  publicationDate: date,
});
const folder = z.strictObject({
  id: folderId,
  name: z.string().trim().min(1).max(160),
  type: folderType,
  parentId: folderId.nullable(),
  paperCount: z.number().int().min(0),
  complete: z.boolean(),
});
export const alphaXivSnapshot = z
  .strictObject({
    takenAt: mirrorTime,
    folders: z.array(folder).max(mirrorFolderCap),
    memberships: z
      .array(
        z.discriminatedUnion("paperType", [
          membership.extend({
            paperType: z.literal("public"),
            paperId: arxivId,
          }),
          membership.extend({
            paperType: z.literal("private"),
            paperId: uploadId,
          }),
        ]),
      )
      .max(20_000),
    annotations: z
      .array(mirrorAnnotation.extend({ paperId: z.union([arxivId, uploadId]) }))
      .max(20_000)
      .optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const folders = new Map(v.folders.map((f) => [f.id, f]));
    if (folders.size !== v.folders.length)
      issue(["folders"], "Duplicate folder ID");
    const listed = new Map<string, Set<string>>();
    for (const [i, m] of v.memberships.entries()) {
      if (!folders.has(m.folderId))
        issue(["memberships", i, "folderId"], "Unknown folder");
      const ids = listed.get(m.folderId) ?? new Set<string>();
      const key = itemKey(m);
      if (ids.has(key))
        issue(["memberships", i, "paperId"], "Duplicate membership");
      ids.add(key);
      listed.set(m.folderId, ids);
    }
    for (const [i, f] of v.folders.entries()) {
      const count = listed.get(f.id)?.size ?? 0;
      if (count > f.paperCount || f.complete !== (count === f.paperCount))
        issue(
          ["folders", i, "complete"],
          "Completeness must match listed and total paper counts",
        );
      const seen = new Set([f.id]);
      let parentId = f.parentId;
      while (parentId !== null) {
        const parent = folders.get(parentId);
        if (!parent || seen.has(parentId)) {
          issue(["folders", i, "parentId"], "Missing or cyclic parent folder");
          break;
        }
        if (seen.size >= 30) {
          issue(["folders", i, "parentId"], "Folder nesting exceeds 30 levels");
          break;
        }
        seen.add(parentId);
        parentId = parent.parentId;
      }
    }
    const annotations = v.annotations ?? [];
    if (new Set(annotations.map((a) => a.paperId)).size !== annotations.length)
      issue(["annotations"], "Duplicate annotation paper ID");
  });

type Snapshot = z.output<typeof alphaXivSnapshot>;

function byKey<T>(key: (value: T) => string) {
  return (left: T, right: T) => {
    const a = key(left);
    const b = key(right);
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

export function orderedAlphaXivSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    folders: snapshot.folders.toSorted(byKey((folder) => folder.id)),
    memberships: snapshot.memberships.toSorted(
      byKey((member) => member.folderId + ":" + itemKey(member)),
    ),
    annotations: snapshot.annotations?.toSorted(
      byKey((entry) => entry.paperId),
    ),
  };
}
export type MirrorChange = {
  kind: "add" | "update" | "remove" | "restore";
  item: MirrorItem;
  previous?: MirrorItem;
};

const itemKey = ({
  paperId,
  paperType,
}: Pick<MirrorItem, "paperId" | "paperType">) => paperType + ":" + paperId;
const defaultStatus = {
  "default-to-read": "saved",
  "default-reading": "reading",
  "default-completed": "read",
} as const;

export function reconcileAlphaXiv(
  snapshot: Snapshot,
  previous: readonly MirrorItem[],
): MirrorChange[] {
  const folders = new Map(snapshot.folders.map((f) => [f.id, f]));
  const paths = new Map<string, MirrorFolder>();
  function folderPath(id: string): MirrorFolder {
    const known = paths.get(id);
    if (known) return known;
    const folder = folders.get(id)!;
    const path = folder.parentId
      ? folderPath(folder.parentId).path + " / " + folder.name
      : folder.name;
    const result = { id, path, type: folder.type };
    paths.set(id, result);
    return result;
  }
  const memberships = new Map<string, Snapshot["memberships"]>();
  for (const m of snapshot.memberships) {
    const key = itemKey(m);
    const list = memberships.get(key) ?? [];
    list.push(m);
    memberships.set(key, list);
  }
  const annotations = new Map(
    snapshot.annotations?.map(({ paperId, highlightCount, hasNotes }) => [
      paperId,
      { highlightCount, hasNotes },
    ]),
  );
  const stored = new Map(previous.map((p) => [itemKey(p), p]));
  const changes: MirrorChange[] = [];
  for (const key of new Set([...stored.keys(), ...memberships.keys()])) {
    const prior = stored.get(key);
    const listed = memberships.get(key) ?? [];
    const member = listed[0] ?? prior!;
    const retained = new Map<string, MirrorFolder>();
    for (const f of prior?.folders ?? []) {
      const current = folders.get(f.id);
      if (current && !current.complete) retained.set(f.id, folderPath(f.id));
    }
    for (const m of listed) retained.set(m.folderId, folderPath(m.folderId));
    const assigned = [...retained.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const types = new Set(assigned.map((f) => f.type));
    const defaultFolder = (
      ["default-completed", "default-reading", "default-to-read"] as const
    ).find((type) => types.has(type));
    const common = {
      paperId: member.paperId,
      title: member.title,
      folders: assigned,
      status: defaultFolder ? defaultStatus[defaultFolder] : ("saved" as const),
    };
    let item: MirrorItem;
    if (member.paperType === "private") {
      item = { ...common, paperType: "private" };
    } else {
      const old = prior?.paperType === "public" ? prior.annotation : null;
      const annotation = annotations.get(member.paperId);
      item = {
        ...common,
        paperType: "public",
        publicationDate: member.publicationDate,
        annotation: annotation ?? old,
      };
    }
    if (
      JSON.stringify(prior && mirrorItem.parse(prior)) ===
      JSON.stringify(mirrorItem.parse(item))
    )
      continue;
    if (!assigned.length && !prior?.folders.length) continue;
    changes.push({
      kind: !prior
        ? "add"
        : !assigned.length
          ? "remove"
          : !prior.folders.length
            ? "restore"
            : "update",
      item,
      previous: prior,
    });
  }
  return changes;
}
