import { describe, expect, it } from "vitest";
import { alphaXivSnapshot, reconcileAlphaXiv } from "../src/alphaxiv";

const parent = "10000000-0000-4000-8000-000000000001";
const child = "10000000-0000-4000-8000-000000000002";
const reading = "10000000-0000-4000-8000-000000000003";
const takenAt = "2026-11-18T10:00:00.000Z";
const folders = [
  {
    id: parent,
    name: "FYP",
    type: "custom",
    parentId: null,
    paperCount: 0,
    complete: true,
  },
  {
    id: child,
    name: "Geometry",
    type: "custom",
    parentId: parent,
    paperCount: 1,
    complete: true,
  },
  {
    id: reading,
    name: "Reading",
    type: "default-reading",
    parentId: null,
    paperCount: 1,
    complete: true,
  },
];
const paper = {
  paperId: "2611.00001v2",
  paperType: "public",
  title: "Stereo geometry",
  publicationDate: "2026-11-01",
};
const snapshot = {
  takenAt,
  folders,
  memberships: [
    { folderId: child, ...paper },
    { folderId: reading, ...paper },
  ],
  annotations: [
    {
      paperId: "2611.00001",
      highlightCount: 3,
      hasNotes: true,
      lastAnnotatedAt: takenAt,
    },
  ],
};

describe("alphaXiv snapshots", () => {
  it("normalizes public IDs and publication timestamps while allowing opaque private IDs", () => {
    const parsed = alphaXivSnapshot.parse({
      ...snapshot,
      memberships: [
        { ...snapshot.memberships[0], publicationDate: takenAt },
        {
          ...snapshot.memberships[1],
          paperId: "upload_7",
          paperType: "private",
          publicationDate: null,
        },
      ],
    });
    expect(
      parsed.memberships.map(({ paperId, publicationDate }) => [
        paperId,
        publicationDate,
      ]),
    ).toEqual([
      ["2611.00001", "2026-11-18"],
      ["upload_7", null],
    ]);
  });

  it.each([
    {
      folders: folders.map((f) =>
        f.id === child ? { ...f, paperCount: 2 } : f,
      ),
    },
    {
      folders: folders.map((f) =>
        f.id === parent ? { ...f, parentId: child } : f,
      ),
    },
    { memberships: [...snapshot.memberships, snapshot.memberships[0]] },
    {
      memberships: [
        {
          ...snapshot.memberships[0],
          folderId: "10000000-0000-4000-8000-000000000009",
        },
      ],
    },
    { annotations: [{ ...snapshot.annotations[0], noteText: "Do not store" }] },
  ])(
    "rejects invalid completeness, folder graphs, memberships and note fields",
    (override) => {
      expect(
        alphaXivSnapshot.safeParse({ ...snapshot, ...override }).success,
      ).toBe(false);
    },
  );
});

describe("alphaXiv reconciliation", () => {
  const initial = () =>
    reconcileAlphaXiv(alphaXivSnapshot.parse(snapshot), []).map(
      ({ item }) => item,
    );
  it("resolves nested names and reading status, and records counts without note text", () => {
    expect(initial()).toMatchObject([
      {
        paperId: "2611.00001",
        status: "reading",
        annotation: { highlightCount: 3, hasNotes: true },
        folders: [
          { id: child, path: "FYP / Geometry", type: "custom" },
          { id: reading, path: "Reading", type: "default-reading" },
        ],
      },
    ]);
  });

  it("keeps missing membership in a capped folder, updates its path, and preserves omitted annotations", () => {
    const next = alphaXivSnapshot.parse({
      takenAt,
      folders: [
        { ...folders[0], name: "Stereo" },
        { ...folders[1], paperCount: 50, complete: false },
        { ...folders[2], paperCount: 0 },
      ],
      memberships: [],
    });
    const [change] = reconcileAlphaXiv(next, initial());
    expect(change).toMatchObject({
      kind: "update",
      item: {
        folders: [{ id: child, path: "Stereo / Geometry" }],
        status: "saved",
        annotation: { hasNotes: true, highlightCount: 3 },
      },
    });
  });

  it("drops deleted folders while preserving unlisted papers in folders that remain capped", () => {
    const capped = { ...folders[2], paperCount: 75, complete: false };
    const next = alphaXivSnapshot.parse({
      takenAt,
      folders: [capped],
      memberships: [],
    });
    const [change] = reconcileAlphaXiv(next, initial());
    expect(change).toMatchObject({
      kind: "update",
      item: { folders: [{ id: reading, path: "Reading" }], status: "reading" },
    });
    const empty = alphaXivSnapshot.parse({
      takenAt,
      folders: [],
      memberships: [],
    });
    expect(reconcileAlphaXiv(empty, [change!.item])).toMatchObject([
      { kind: "remove", item: { folders: [] } },
    ]);
  });

  it("removes only when the last membership is in a complete folder and supports restoration", () => {
    const empty = alphaXivSnapshot.parse({
      takenAt,
      folders: folders.map((f) => ({ ...f, paperCount: 0 })),
      memberships: [],
    });
    const original = initial();
    const [removed] = reconcileAlphaXiv(empty, original);
    expect(removed).toMatchObject({ kind: "remove", item: { folders: [] } });
    expect(reconcileAlphaXiv(empty, [removed!.item])).toEqual([]);
    expect(
      reconcileAlphaXiv(alphaXivSnapshot.parse(snapshot), [removed!.item]),
    ).toMatchObject([{ kind: "restore" }]);
  });

  it.each([
    ["default-to-read", "saved"],
    ["default-reading", "reading"],
    ["default-completed", "read"],
  ])("maps %s to %s", (type, status) => {
    const v = alphaXivSnapshot.parse({
      ...snapshot,
      folders: [folders[0], folders[1], { ...folders[2], type }],
    });
    expect(reconcileAlphaXiv(v, [])[0]?.item.status).toBe(status);
  });
});
