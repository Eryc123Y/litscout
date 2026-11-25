import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  upsertPaper,
  getPaper,
  deletePaper,
  searchPapers,
  putFeedDay,
  listFeedDays,
  putFeedItem,
  listFeedItems,
  putSummary,
  listSummaries,
  putDigest,
  getDigest,
  putRun,
  listRuns,
  createApiToken,
  findApiToken,
  revokeApiToken,
  touchApiToken,
  listApiTokens,
  listPaperLinks,
  getPaperIdentifiers,
} from "../src/index";
import { databaseHarness } from "./harness";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
describe.each(["sqlite", "d1"] as const)("repositories in %s", (backend) => {
  async function setup() {
    const h = await databaseHarness(backend);
    cleanup.push(h.close);
    return h.db;
  }
  const input = {
    title: "Stereo vision",
    abstract: "Depth reconstruction",
    identifiers: [{ scheme: "doi" as const, value: "10.1234/STEREO" }],
    links: [{ kind: "landing" as const, url: "https://example.org/paper" }],
  };
  it("upserts idempotently, normalises unique identifiers and rejects stale writes", async () => {
    const db = await setup();
    const one = await upsertPaper(db, input, 0);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const two = await upsertPaper(db, input, 1);
    expect(two).toMatchObject({
      ok: true,
      value: { id: one.value.id, rev: 1 },
    });
    expect(
      await upsertPaper(db, { ...input, title: "Changed" }, 0),
    ).toMatchObject({ ok: false, conflict: { rev: 1 } });
    expect(
      await upsertPaper(db, { ...input, title: "Changed" }, 1),
    ).toMatchObject({ ok: true, value: { rev: 2 } });
    expect(
      (await db.all<{ n: number }>(sql`select count(*) as n from paper_ids`))[0]
        ?.n,
    ).toBe(1);
    await expect(async () =>
      db.run(
        sql`insert into paper_ids(paper_id,scheme,value) values(${one.value.id},'doi','10.1234/stereo')`,
      ),
    ).rejects.toThrow();
  });
  it("merges identifier bridges and preserves linked feed items", async () => {
    const db = await setup();
    const a = await upsertPaper(db, input, 0);
    const b = await upsertPaper(
      db,
      {
        title: "Preprint",
        identifiers: [{ scheme: "arxiv", value: "2601.00001v2" }],
      },
      0,
    );
    if (!a.ok || !b.ok) throw Error("setup");
    await putFeedDay(db, { day: "2026-11-17" }, 0);
    await putFeedItem(
      db,
      { day: "2026-11-17", paperId: b.value.id, source: "arxiv" },
      0,
    );
    const merged = await upsertPaper(
      db,
      {
        ...input,
        identifiers: [
          ...input.identifiers,
          { scheme: "arxiv", value: "2601.00001" },
        ],
      },
      1,
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect((await listFeedItems(db, "2026-11-17"))[0]?.paperId).toBe(
        merged.value.id,
      );
      expect(
        (await db.all<{ n: number }>(sql`select count(*) as n from papers`))[0]
          ?.n,
      ).toBe(1);
    }
  });
  it("searches external-content FTS including TLDR and hides deleted papers", async () => {
    const db = await setup();
    const p = await upsertPaper(db, input, 0);
    if (!p.ok) throw Error("setup");
    await putSummary(
      db,
      {
        paperId: p.value.id,
        content: {
          tldr: "Binocular geometry",
          motivation: "",
          method: "",
          result: "",
          conclusion: "",
        },
      },
      0,
    );
    expect(await searchPapers(db, "Binocular")).toHaveLength(1);
    expect(await deletePaper(db, p.value.id, 0)).toMatchObject({ ok: false });
    expect(await deletePaper(db, p.value.id, 1)).toMatchObject({ ok: true });
    expect(await getPaper(db, p.value.id)).toBeNull();
    expect(await searchPapers(db, "Stereo")).toEqual([]);
    expect(await deletePaper(db, "pap_missing", 1)).toMatchObject({
      ok: false,
      conflict: null,
    });
  });
  it("round-trips feeds, summaries, digests and runs with revision conflicts", async () => {
    const db = await setup();
    const p = await upsertPaper(db, input, 0);
    if (!p.ok) throw Error("setup");
    expect(await putFeedDay(db, { day: "2026-11-17" }, 0)).toMatchObject({
      ok: true,
    });
    expect(
      await putFeedDay(db, { day: "2026-11-17", status: "crawled" }, 0),
    ).toMatchObject({ ok: false });
    expect(
      await putFeedDay(db, { day: "2026-11-17", status: "crawled" }, 1),
    ).toMatchObject({ ok: true });
    expect(await listFeedDays(db)).toHaveLength(1);
    const item = { day: "2026-11-17", paperId: p.value.id, source: "arxiv" };
    await putFeedItem(db, item, 0);
    expect(await putFeedItem(db, item, 0)).toMatchObject({ ok: false });
    expect(await listFeedItems(db, item.day)).toHaveLength(1);
    const summary = {
      paperId: p.value.id,
      content: {
        tldr: "TLDR",
        motivation: "",
        method: "",
        result: "",
        conclusion: "",
      },
    };
    await putSummary(db, summary, 0);
    expect(await putSummary(db, summary, 0)).toMatchObject({ ok: false });
    expect(await listSummaries(db, p.value.id)).toHaveLength(1);
    await putDigest(db, { day: item.day, bodyMd: "Digest" }, 0);
    expect(
      await putDigest(db, { day: item.day, bodyMd: "stale" }, 0),
    ).toMatchObject({ ok: false });
    expect(await getDigest(db, item.day)).toMatchObject({ bodyMd: "Digest" });
    expect(await getDigest(db, "2026-11-16")).toBeNull();
    const run = await putRun(
      db,
      { kind: "cron", day: item.day, status: "done" },
      0,
    );
    if (!run.ok) throw Error("setup");
    expect(
      await putRun(db, { ...run.value, status: "failed" }, 0),
    ).toMatchObject({ ok: false });
    expect(await listRuns(db)).toHaveLength(1);
  });
  it("stores token hashes, filters revoked tokens, and throttles last use updates", async () => {
    const db = await setup();
    const hash = "a".repeat(64);
    const t = await createApiToken(db, {
      name: "test",
      hash,
      scopes: ["read"],
    });
    expect(await findApiToken(db, hash)).toMatchObject({
      id: t.id,
      scopes: ["read"],
    });
    await touchApiToken(db, t.id, "2026-11-17T00:00:00.000Z");
    await touchApiToken(db, t.id, "2026-11-17T00:00:30.000Z");
    expect((await findApiToken(db, hash))?.lastUsedAt).toBe(
      "2026-11-17T00:00:00.000Z",
    );
    await touchApiToken(db, t.id, "2026-11-17T00:01:01.000Z");
    expect((await findApiToken(db, hash))?.lastUsedAt).toBe(
      "2026-11-17T00:01:01.000Z",
    );
    await revokeApiToken(db, t.id);
    expect(await findApiToken(db, hash)).toBeNull();
    expect(await findApiToken(db, "b".repeat(64))).toBeNull();
  });
  it("rejects invalid input before writing", async () => {
    const db = await setup();
    await expect(upsertPaper(db, { ...input, title: "" }, 0)).rejects.toThrow();
    await expect(putFeedDay(db, { day: "bad" }, 0)).rejects.toThrow();
  });
  it("handles concurrent creates without orphan papers or lost revision checks", async () => {
    const db = await setup();
    const results = await Promise.all([
      upsertPaper(db, input, 0),
      upsertPaper(db, input, 0),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(
      (await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM papers`))[0]
        ?.n,
    ).toBe(1);
    const days = await Promise.all([
      putFeedDay(db, { day: "2026-11-16" }, 0),
      putFeedDay(db, { day: "2026-11-16" }, 0),
    ]);
    expect(days.filter((r) => r.ok)).toHaveLength(1);
    expect(await putFeedDay(db, { day: "2026-11-15" }, 1)).toEqual({
      ok: false,
      conflict: null,
    });
  });
  it("preserves metadata when adding identifiers and links and revives deleted papers", async () => {
    const db = await setup();
    const v = {
      ...input,
      authors: [{ name: "Author" }],
      venue: "Venue",
      year: 2026,
      links: [
        { kind: "landing", url: "https://example.org/paper", licence: "CC-BY" },
      ],
    };
    const p = await upsertPaper(db, v, 0);
    if (!p.ok) throw Error("setup");
    expect(await getPaperIdentifiers(db, p.value.id)).toHaveLength(1);
    expect(await listPaperLinks(db, p.value.id)).toHaveLength(1);
    const updated = await upsertPaper(
      db,
      {
        ...v,
        identifiers: [
          ...input.identifiers,
          { scheme: "openalex", value: "W123" },
        ],
      },
      1,
    );
    expect(updated).toMatchObject({ ok: true, value: { rev: 2 } });
    const changed = await upsertPaper(
      db,
      { ...v, venue: "New", year: 2025 },
      2,
    );
    expect(changed).toMatchObject({ ok: true, value: { venue: "New" } });
    await deletePaper(db, p.value.id, 3);
    expect(await upsertPaper(db, v, 4)).toMatchObject({
      ok: true,
      value: { deletedAt: null },
    });
    const anonymous = await upsertPaper(db, { title: "Unidentified work" }, 0);
    expect(anonymous.ok).toBe(true);
    await createApiToken(db, {
      name: "read",
      hash: "b".repeat(64),
      scopes: ["read"],
    });
    expect(await listApiTokens(db)).toHaveLength(1);
    expect(await listFeedDays(db, 100, "2026-11-17")).toEqual([]);
  });
  it("retains richer metadata when an identifier bridge merges sparse records", async () => {
    const db = await setup();
    const a = await upsertPaper(
      db,
      { title: "Published", identifiers: input.identifiers },
      0,
    );
    const b = await upsertPaper(
      db,
      {
        title: "Preprint",
        abstract: "Important retained abstract",
        authors: [{ name: "Author" }],
        venue: "Venue",
        year: 2026,
        identifiers: [{ scheme: "arxiv", value: "2601.00002" }],
      },
      0,
    );
    if (!a.ok || !b.ok) throw Error("setup");
    const merged = await upsertPaper(
      db,
      {
        title: "Published",
        identifiers: [
          ...input.identifiers,
          { scheme: "arxiv", value: "2601.00002" },
        ],
      },
      1,
    );
    expect(merged).toMatchObject({
      ok: true,
      value: {
        abstract: "Important retained abstract",
        authors: [{ name: "Author" }],
        venue: "Venue",
        year: 2026,
      },
    });
  });
});
