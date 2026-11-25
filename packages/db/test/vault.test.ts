import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { titleKey } from "@litscout/core/normalize";
import type { SyncReport, VaultNote } from "@litscout/pipeline/vault-contracts";
import { databaseHarness } from "./harness";
import {
  getVaultIndex,
  publishVaultIndex,
  stageVaultIndex,
  vaultIndexIds,
} from "../src/vault-index";
import { backfillVaultTitleKeys } from "../src/vault-title-matches";
import {
  listVaultProjects,
  listVaultIdeas,
  lookupVaultMatches,
  paperVaultNote,
  readVaultDigest,
  readVaultPapers,
  vaultIdeaById,
} from "../src/vault-reads";
import {
  cancelVaultRequest,
  claimVaultRequest,
  createVaultRequest,
  getVaultStatus,
  recordVaultSync,
  queuedVaultRequests,
  resolveVaultRequest,
} from "../src/vault-requests";

const h = (value: string) => createHash("sha256").update(value).digest("hex");
const date = "2026-11-18T02:00:00.000Z";
const base = (path: string, title: string) => ({
  path,
  title,
  id: h(path),
  hash: h(title),
  bodyHash: h("body"),
});
const project = {
  ...base("Projects/Stereo.md", "Stereo"),
  kind: "project",
  frontmatter: { description: "Stereo pipeline" },
} satisfies VaultNote;
const idea = {
  ...base("Idea.md", "Stereo idea"),
  kind: "idea",
  frontmatter: {
    project: "[[Projects/Stereo]]",
    status: "seed",
    papers: ["2406.09414"],
  },
} satisfies VaultNote;
const draft = {
  ...base("Draft.md", "Stereo draft"),
  kind: "working_paper",
  frontmatter: { ideas: ["[[Idea]]"], papers: ["10.1000/stereo"] },
} satisfies VaultNote;
const paperNote = {
  ...base("Paper.md", "Stereo paper"),
  kind: "paper_note",
  frontmatter: { doi: "10.1000/stereo", maturity: "understood" },
} satisfies VaultNote;

for (const backend of ["sqlite", "d1"] as const) {
  it(`matches identifier-free notes by a unique folded title in ${backend}`, async () => {
    const { db, close } = await databaseHarness(backend);
    try {
      const title = "Café—Depth: 立体視";
      const candidate = {
        id: h("title candidate"),
        title: "CAFE   depth, 立体視!",
      };
      const note = {
        ...base("Reading/Alternate filename.md", candidate.title),
        kind: "paper_note",
        frontmatter: {},
      } satisfies VaultNote;
      const start = { snapshot: h("title snapshot"), previous: null };
      const refresh = {
        snapshot: start.snapshot,
        previous: start.snapshot,
        parts: 1,
        count: 1,
        changes: 0,
      };
      await stageVaultIndex(db, { ...start, part: 0, notes: [note] });
      await publishVaultIndex(
        db,
        { ...start, parts: 1, count: 1, changes: 1 },
        date,
      );
      await db.run(sql`INSERT INTO papers(id,title,title_norm) VALUES
        ('unique',${title},${titleKey(title)}),
        ('different-script','Cafe depth 机器',${titleKey("Cafe depth 机器")}),
        ('different-words','Cafedepth 立体視',${titleKey("Cafedepth 立体視")}),
        ('ambiguous1','Repeated title',${titleKey("Repeated title")}),
        ('ambiguous2','Repeated—title',${titleKey("Repeated—title")})`);
      await db.run(sql`INSERT INTO paper_index(paper_id,day,title) VALUES
        ('unique','2026-11-18',${title}),
        ('archive-only','2026-11-18','Méthode archivée')`);
      await db.run(sql`INSERT INTO paper_ids(paper_id,scheme,value) VALUES
        ('different-script','doi','10.1000/other')`);
      expect(await paperVaultNote(db, "unique")).toEqual({
        path: null,
        pending: false,
      });
      // Five papers and two compact rows have no title key yet.
      expect(await getVaultIndex(db, true)).not.toHaveProperty(
        "titleKeysPendingCount",
      );
      expect(await getVaultIndex(db, true, true)).toMatchObject({
        titleKeysPending: true,
        titleKeysPendingCount: 7,
      });
      expect(await backfillVaultTitleKeys(db)).toMatchObject({
        titleKeysPending: false,
      });
      expect(await getVaultIndex(db, true, true)).toMatchObject({
        titleKeysPending: false,
        titleKeysPendingCount: 0,
      });
      expect(await publishVaultIndex(db, refresh, date)).toMatchObject({
        published: true,
      });

      expect(
        await lookupVaultMatches(db, [
          candidate,
          { id: "explicit", title, doi: "10.1000/other" },
          { id: "wrong-id", title, doi: "10.1000/missing" },
          { id: "archive", title: "Methode archivee" },
          { id: "ambiguous", title: "Repeated title" },
          { id: "blank", title: "!!!" },
        ]),
      ).toEqual(
        expect.arrayContaining([
          { id: candidate.id, paperId: "unique", matchedBy: "title" },
          { id: "explicit", paperId: "different-script" },
          { id: "archive", paperId: "archive-only", matchedBy: "title" },
        ]),
      );
      expect(
        await lookupVaultMatches(db, [
          { id: "wrong-id", title, doi: "10.1000/missing" },
          { id: "ambiguous", title: "Repeated title" },
          { id: "blank", title: "!!!" },
        ]),
      ).toEqual([]);
      expect(await paperVaultNote(db, "unique")).toEqual({
        path: note.path,
        pending: false,
        matchedBy: "title",
      });
      await expect(
        createVaultRequest(
          db,
          { kind: "make_paper_note", paperId: "unique" },
          date,
        ),
      ).rejects.toThrow(note.path);

      await db.run(sql`INSERT INTO paper_index(paper_id,day,title) VALUES
        ('second','2026-11-18','Cafe depth — 立体視')`);
      expect(await paperVaultNote(db, "unique")).toMatchObject({
        path: note.path,
        matchedBy: "title",
      });
      await backfillVaultTitleKeys(db);
      expect(await publishVaultIndex(db, refresh, date)).toMatchObject({
        published: true,
      });
      for (const id of ["unique", "second"])
        expect(await paperVaultNote(db, id)).toEqual({
          path: null,
          pending: false,
        });
      expect(await lookupVaultMatches(db, [candidate])).toEqual([]);

      await db.run(sql`INSERT INTO papers(id,title,title_norm,deleted_at) VALUES
        ('second',${title},${titleKey(title)},${date})`);
      expect(await lookupVaultMatches(db, [candidate])).toEqual([
        { id: candidate.id, paperId: "unique", matchedBy: "title" },
      ]);
      await publishVaultIndex(db, refresh, date);
      expect(await paperVaultNote(db, "unique")).toMatchObject({
        path: note.path,
        matchedBy: "title",
      });
    } finally {
      await close();
    }
  });

  it(`publishes a complete snapshot atomically, links papers and soft-deletes missing notes in ${backend}`, async () => {
    const { db, close } = await databaseHarness(backend);
    try {
      await db.run(
        sql`INSERT INTO papers(id,title,title_norm) VALUES ('pap_test','A stereo paper','a stereo paper'), ('pap_other','Another','another')`,
      );
      await db.run(
        sql`INSERT INTO paper_ids (paper_id,scheme,value) VALUES ('pap_test','arxiv','2406.09414'),('pap_other','doi','10.1000/stereo')`,
      );
      const snapshot = h("snapshot A");
      const start = { snapshot, previous: null };
      await stageVaultIndex(db, { ...start, part: 0, notes: [project, idea] });
      expect(
        await publishVaultIndex(
          db,
          { ...start, parts: 2, count: 4, changes: 4 },
          date,
        ),
      ).toMatchObject({ published: false });
      expect(await getVaultIndex(db)).toEqual({ snapshot: null, count: 0 });
      await stageVaultIndex(db, {
        ...start,
        part: 1,
        notes: [draft, paperNote],
      });
      expect(
        await publishVaultIndex(
          db,
          { ...start, parts: 2, count: 4, changes: 4 },
          date,
        ),
      ).toMatchObject({ published: true });
      await db.run(
        sql`INSERT INTO radar_grades (id,day,paper_id,project_id,level,reason) VALUES ('rad_test','2026-11-18','pap_test',${project.id},'high','A good match')`,
      );
      expect(await listVaultProjects(db)).toMatchObject([
        {
          title: "Stereo",
          ideas: [{ title: "Stereo idea" }],
          papers: [{ id: "pap_test" }, { id: "pap_other" }],
          radar: [{ id: "rad_test" }],
        },
      ]);
      expect(await paperVaultNote(db, "pap_other")).toEqual({
        path: "Paper.md",
        pending: false,
      });
      expect(await vaultIdeaById(db, idea.id)).toMatchObject({
        path: "Idea.md",
        projectId: project.id,
      });
      expect(await getVaultIndex(db)).toEqual({ snapshot, count: 4 });
      const next = { snapshot: h("snapshot B"), previous: snapshot };
      await stageVaultIndex(db, {
        ...next,
        part: 0,
        notes: [],
        removed: [idea.id, draft.id, paperNote.id],
      });
      expect(
        await publishVaultIndex(
          db,
          { ...next, parts: 1, count: 1, changes: 3 },
          date,
        ),
      ).toMatchObject({ published: true });
      expect(await vaultIdeaById(db, idea.id)).toBeNull();
      expect(await paperVaultNote(db, "pap_other")).toEqual({
        path: null,
        pending: false,
      });
      expect(
        await db.get(
          sql`SELECT deleted_at FROM vault_notes WHERE id=${idea.id}`,
        ),
      ).toEqual({ deleted_at: date });
      expect(
        await publishVaultIndex(
          db,
          { ...start, parts: 2, count: 4, changes: 4 },
          date,
        ),
      ).toMatchObject({ published: false });
    } finally {
      await close();
    }
  });
}
it("binds requests to the current index, protects claimed requests and purges handed-off captures", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    const run = { snapshot: h("snapshot"), previous: null };
    await stageVaultIndex(db, { ...run, part: 0, notes: [idea] });
    await publishVaultIndex(
      db,
      { ...run, parts: 1, count: 1, changes: 1 },
      date,
    );
    const status = await createVaultRequest(
      db,
      { kind: "set_status", targetNoteId: idea.id, status: "parked" },
      date,
    );
    const capture = await createVaultRequest(
      db,
      { kind: "capture", title: "A thought", body: "Short text" },
      date,
    );
    expect(await queuedVaultRequests(db, date, "en")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: status.id,
          target: { path: idea.path, id: idea.id },
          baseHash: idea.hash,
        }),
        expect.objectContaining({ id: capture.id, body: "Short text" }),
      ]),
    );
    const claim = "42cfbffe-c535-4aa1-85a2-bcf5bd122245";
    expect(await claimVaultRequest(db, capture.id, claim, date)).toBe(true);
    expect(await cancelVaultRequest(db, capture.id, date)).toMatchObject({
      ended: false,
    });
    expect(
      await resolveVaultRequest(
        db,
        capture.id,
        { state: "applied", claim },
        date,
      ),
    ).toMatchObject({ ended: true });
    expect(await db.all(sql`SELECT * FROM captures`)).toEqual([]);
    expect(await cancelVaultRequest(db, status.id, date)).toMatchObject({
      ended: true,
    });
    expect(await queuedVaultRequests(db, date, "en")).toHaveLength(0);
  } finally {
    await close();
  }
});

it("rejects duplicate rows in a staged change and accepts a corrected replay only", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    const run = { snapshot: h("version A"), previous: null };
    const input = { ...run, part: 0, notes: [idea, idea] };
    await stageVaultIndex(db, input);
    expect(await stageVaultIndex(db, input)).toEqual({
      accepted: true,
      rowsWritten: 0,
    });
    expect(
      await publishVaultIndex(
        db,
        { ...run, parts: 1, count: 2, changes: 2 },
        date,
      ),
    ).toEqual({ published: false, rowsWritten: 0 });
    expect(await vaultIndexIds(db, "", 2)).toEqual([]);
    await stageVaultIndex(db, { ...input, notes: [idea] });
    const fixed = { ...run, parts: 1, count: 1, changes: 1 };
    expect(await publishVaultIndex(db, fixed, date)).toMatchObject({
      published: true,
    });
    expect(await publishVaultIndex(db, fixed, date)).toEqual({
      published: true,
      rowsWritten: 0,
    });
    expect(await stageVaultIndex(db, input)).toEqual({
      accepted: false,
      rowsWritten: 0,
    });
    expect(await vaultIndexIds(db, "", 1)).toEqual([
      { id: idea.id, fingerprint: h(JSON.stringify(idea)) },
    ]);
    expect(await vaultIndexIds(db, idea.id, 1)).toEqual([]);
    expect(await listVaultIdeas(db, "", 1)).toMatchObject([
      { id: idea.id, path: idea.path },
    ]);
  } finally {
    await close();
  }
});

it("loads only eligible paper details and a language-matched daily digest", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    const english = {
      tldr: "English",
      motivation: "M",
      method: "M",
      result: "R",
      conclusion: "C",
    };
    const chinese = { ...english, tldr: "中文" };
    await db.run(sql`INSERT INTO papers(id,title,title_norm,deleted_at) VALUES
      ('live','Live paper','live paper',NULL),('removed','Removed','removed',${date})`);
    await db.run(sql`INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title,topics) VALUES
      ('archive','2406.09414','10.1000/archive','2026-11-18','Archived paper','["Archive"]'),
      ('removed',NULL,NULL,'2026-11-18','Removed','[]')`);
    await db.run(
      sql`INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('live','arxiv','2406.09415')`,
    );
    await db.run(sql`INSERT INTO paper_links(id,paper_id,kind,url) VALUES
      ('invalid','live','landing','https://'),('landing','live','landing','https://fixture.invalid/landing'),
      ('pdf','live','pdf_oa','https://fixture.invalid/paper.pdf')`);
    await db.run(
      sql`INSERT INTO summaries(paper_id,lang,content) VALUES ('live','en',${JSON.stringify(english)}), ('live','zh',${JSON.stringify(chinese)})`,
    );
    await db.run(sql`INSERT INTO notes(id,target_type,target_id,body_md,origin,deleted_at) VALUES
      ('quick','paper','live','Quick note','cli',NULL),('deleted','paper','live','Deleted note','cli',${date})`);
    await db.run(sql`INSERT INTO digests(day,lang,kind,body_md) VALUES
      ('2026-11-18','en','daily','Daily'),('2026-11-18','zh','daily','日报'),('2026-11-18','en','weekly','Weekly')`);

    expect(
      await lookupVaultMatches(db, [
        { id: "exact", doi: "10.1000/archive" },
        { id: "conflict", arxiv: "2406.09415", doi: "10.1000/archive" },
        { id: "missing", doi: "10.1000/missing" },
      ]),
    ).toEqual([{ id: "exact", paperId: "archive" }]);
    const papers = await readVaultPapers(
      db,
      ["archive", "live", "removed", "missing", "live"],
      "zh",
    );
    expect(papers).toHaveLength(2);
    expect(papers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "archive",
          doi: "10.1000/archive",
          topics: ["Archive"],
          notes: [],
        }),
        expect.objectContaining({
          id: "live",
          url: "https://fixture.invalid/landing",
          summary: chinese,
          notes: ["Quick note"],
          links: [
            { kind: "landing", url: "https://fixture.invalid/landing" },
            { kind: "pdf_oa", url: "https://fixture.invalid/paper.pdf" },
          ],
        }),
      ]),
    );
    expect(await readVaultPapers(db, [], "en")).toEqual([]);
    expect(await readVaultDigest(db, "2026-11-18", "zh")).toEqual({
      day: "2026-11-18",
      markdown: "日报",
    });
    expect(await readVaultDigest(db, "2026-11-19", "en")).toBeNull();
  } finally {
    await close();
  }
});

it("deduplicates paper-note requests and rejects inaccessible targets", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    await db.run(
      sql`INSERT INTO papers(id,title,title_norm) VALUES ('new','New paper','new paper'), ('already','Has note','has note')`,
    );
    await db.run(
      sql`INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('already','doi','10.1000/stereo')`,
    );
    const run = { snapshot: h("snapshot for requests"), previous: null };
    await stageVaultIndex(db, {
      ...run,
      part: 0,
      notes: [draft, paperNote, idea],
    });
    await publishVaultIndex(
      db,
      { ...run, parts: 1, count: 3, changes: 3 },
      date,
    );

    await expect(
      createVaultRequest(
        db,
        { kind: "make_paper_note", paperId: "absent" },
        date,
      ),
    ).rejects.toThrow("paper is unavailable");
    await expect(
      createVaultRequest(
        db,
        { kind: "make_paper_note", paperId: "already" },
        date,
      ),
    ).rejects.toThrow("already has a vault note");
    await expect(
      createVaultRequest(
        db,
        { kind: "add_reading", targetNoteId: idea.id, paperId: "new" },
        date,
      ),
    ).rejects.toThrow("target note is unavailable");
    const make = {
      kind: "make_paper_note" as const,
      paperId: "new",
      topic: "Stereo",
    };
    const first = await createVaultRequest(db, make, date);
    expect(await createVaultRequest(db, make, date)).toEqual({
      id: first.id,
      state: "queued",
      rowsWritten: 0,
    });
    expect(await paperVaultNote(db, "new")).toEqual({
      path: null,
      pending: true,
    });

    const capture = await createVaultRequest(
      db,
      {
        kind: "capture",
        title: "Paper idea",
        paperId: "new",
      },
      date,
      "mcp:fixture",
    );
    expect(
      await db.get(
        sql`SELECT source_paper_id,suggestion_id,body_md FROM captures WHERE id=${capture.id}`,
      ),
    ).toEqual({
      source_paper_id: "new",
      suggestion_id: null,
      body_md: "",
    });
    expect(await queuedVaultRequests(db, date, "en")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          topic: "Stereo",
          paper: expect.objectContaining({ id: "new" }),
        }),
        expect.objectContaining({
          id: capture.id,
          body: "",
          paper: expect.objectContaining({ id: "new" }),
        }),
      ]),
    );
    expect(await cancelVaultRequest(db, capture.id, date)).toMatchObject({
      ended: true,
    });
    expect(await db.all(sql`SELECT id FROM captures`)).toEqual([]);
  } finally {
    await close();
  }
});

it("protects claims, retains rejected reasons and returns the last sync report", async () => {
  const { db, close } = await databaseHarness("sqlite");
  try {
    expect(await getVaultStatus(db, date)).toEqual({
      last: null,
      queued: [],
      rejected: [],
      queuedCount: 0,
    });
    const run = { snapshot: h("claims starting index"), previous: null };
    await stageVaultIndex(db, { ...run, part: 0, notes: [idea] });
    await publishVaultIndex(
      db,
      { ...run, parts: 1, count: 1, changes: 1 },
      date,
    );
    const item = await createVaultRequest(
      db,
      { kind: "set_status", targetNoteId: idea.id, status: "parked" },
      date,
    );
    const owner = "b61f1bfd-a9d6-4a04-9818-ab865754c3df";
    const other = "09b09316-4bf5-48b3-834f-047cda687abd";
    const afterExpiry = "2026-11-18T02:11:00.000Z";
    expect(
      await claimVaultRequest(db, item.id, owner, date, h("predicted")),
    ).toBe(true);
    expect(await claimVaultRequest(db, item.id, other, date)).toBe(false);
    expect(
      await resolveVaultRequest(
        db,
        item.id,
        { state: "applied", claim: other },
        date,
      ),
    ).toMatchObject({ ended: false });
    expect(await queuedVaultRequests(db, date, "en")).toEqual([]);
    expect(await getVaultStatus(db, date)).toMatchObject({
      queuedCount: 1,
      queued: [{ id: item.id, applying: true }],
    });
    expect(await queuedVaultRequests(db, afterExpiry, "en")).toMatchObject([
      { id: item.id, resultHash: h("predicted") },
    ]);
    expect(await claimVaultRequest(db, item.id, other, afterExpiry)).toBe(true);
    expect(
      await resolveVaultRequest(
        db,
        item.id,
        { state: "rejected", reason: "Vault changed", claim: other },
        afterExpiry,
      ),
    ).toMatchObject({ ended: true });
    const report: SyncReport = {
      writeEnabled: false,
      counts: {
        project: 0,
        idea: 1,
        working_paper: 0,
        paper_note: 0,
        brief: 0,
      },
      writes: [],
      handEdited: [],
      issues: [{ path: "Invalid: name.md", reason: "Invalid vault path" }],
    };
    await recordVaultSync(db, report, afterExpiry);
    expect(await getVaultStatus(db, afterExpiry)).toEqual({
      last: { ...report, at: afterExpiry },
      queued: [],
      queuedCount: 0,
      rejected: [
        {
          id: item.id,
          kind: "set_status",
          title: idea.title,
          reason: "Vault changed",
          resolvedAt: afterExpiry,
        },
      ],
    });
  } finally {
    await close();
  }
});
