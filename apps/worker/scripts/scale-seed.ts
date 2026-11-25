import { createHash } from "node:crypto";
import { fixture, textGenerator } from "@litscout/db/scripts/size-model";
import { shiftDay } from "@litscout/pipeline/daily";
import { shiftMonth } from "@litscout/pipeline/trends-contracts";

export const papersPerDay = 1000;
export const fullDays = 45;
export const compactPapers = 60_000;
export const vaultSize = 760;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const paperId = (i: number) => "pap_scale_" + String(i).padStart(6, "0");
export const arxivId = (i: number, day: string) =>
  day.slice(2, 7).replace("-", "") + "." + String(i % 100_000).padStart(5, "0");

const subjects = [
  ["stereo", "cs.CV", "stereo depth from video"],
  ["vision", "cs.CV", "visual representation learning"],
  ["learning", "cs.LG", "efficient neural learning"],
  ["language", "cs.CL", "language model alignment"],
  ["robotics", "cs.RO", "robot motion planning"],
  ["graphics", "cs.GR", "graphics animation and rendering"],
] as const;
const theme = (i: number) =>
  subjects[(i % 20 < 8 ? 0 : Math.floor(i / 7)) % subjects.length]!;

export function vaultNote(i: number, day: string) {
  const kind =
    i < 40
      ? "project"
      : i < 240
        ? "idea"
        : i < 260
          ? "working_paper"
          : "paper_note";
  const path = `Scale/${kind}-${i}.md`;
  const title = `${theme(i)[2]} ${kind} ${i}`;
  return {
    id: hash(path),
    path,
    kind,
    title,
    frontmatter:
      kind === "paper_note"
        ? {
            arxiv: arxivId(
              (i - 260) * 11,
              shiftDay(day, -Math.floor(((i - 260) * 11) / papersPerDay)),
            ),
            doi: `10.1234/scale.${(i - 260) * 11}`,
          }
        : {},
    hash: hash(title),
    bodyHash: hash("body " + i),
  };
}

export async function seedScale(db: D1Database, newest: string) {
  const dates = Array.from({ length: fullDays + 365 }, (_, offset) =>
    shiftDay(newest, -offset),
  );
  const timestamp = (day: string) => day + "T08:00:00.000Z";
  const payload = (sql: string, records: unknown) =>
    db.prepare(sql).bind(JSON.stringify(records));
  await db
    .prepare(
      `INSERT INTO feed_days(day,status,crawled_at)
    SELECT value,CASE WHEN key<?2 THEN 'digested' ELSE 'crawled' END,value||'T08:00:00.000Z' FROM json_each(?1)`,
    )
    .bind(JSON.stringify(dates), fullDays)
    .run();

  const text = textGenerator();
  const corpus = Array.from({ length: 256 }, (_, i) => fixture(i, text));
  for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
    const full = dayIndex < fullDays;
    const archiveIndex = dayIndex - fullDays;
    const start = full
      ? dayIndex * papersPerDay
      : fullDays * papersPerDay +
        Math.floor((archiveIndex * compactPapers) / 365);
    const end = full
      ? start + papersPerDay
      : fullDays * papersPerDay +
        Math.floor(((archiveIndex + 1) * compactPapers) / 365);
    const day = dates[dayIndex]!;
    const at = timestamp(day);
    for (let offset = start; offset < end; offset += 100) {
      const records = Array.from(
        { length: Math.min(100, end - offset) },
        (_, j) => {
          const i = offset + j;
          const [topic, category, label] = theme(i);
          const sample = corpus[i % corpus.length]!;
          const title =
            (i % 997 === 0 ? "birefringence " : "") +
            label +
            " " +
            sample.title +
            " " +
            i;
          return {
            id: paperId(i),
            arxiv: arxivId(i, day),
            doi: i % 4 === 0 ? `10.1234/scale.${i}` : null,
            day,
            at,
            title,
            category,
            source: i % 20 === 19 ? "venue" : "arxiv",
            topics:
              i % 5 === 0 && topic !== "vision" ? [topic, "vision"] : [topic],
            rank: i - start + 1,
            shortlisted: Number((i - start) % 11 === 0),
            ...(full
              ? {
                  abstract: sample.abstract,
                  summary: {
                    ...(JSON.parse(sample.summary) as object),
                    motivation: "Estimate depth under motion.",
                    method: "Compare two camera views.",
                    result: "Lower error on the selected sequences.",
                    conclusion: "Test under different lighting.",
                  },
                  authors: [
                    { name: "Mira Chen" },
                    { name: "Ari " + (i % 281) },
                  ],
                  summaryCount: i % 10 === 9 ? 0 : dayIndex < 14 ? 2 : 1,
                }
              : {}),
          };
        },
      );
      await db.batch([
        ...(full
          ? [
              payload(
                `INSERT INTO papers(id,title,title_norm,vault_title_norm,abstract,authors,first_seen_on,published_on,primary_category,categories,source,created_at,updated_at)
            SELECT value->>'id',value->>'title',lower(value->>'title'),lower(value->>'title'),value->>'abstract',value->'authors',
              value->>'day',value->>'day',value->>'category',json_array(value->>'category'),value->>'source',value->>'at',value->>'at' FROM json_each(?)`,
                records,
              ),
              payload(
                `INSERT INTO paper_ids(paper_id,scheme,value)
            SELECT value->>'id','arxiv',value->>'arxiv' FROM json_each(?1) WHERE value->>'source'='arxiv'
            UNION ALL SELECT value->>'id','doi',value->>'doi' FROM json_each(?1) WHERE value->>'doi' IS NOT NULL`,
                records,
              ),
              payload(
                `INSERT INTO paper_links(id,paper_id,kind,url,checked_at)
            SELECT (value->>'id')||':pdf',value->>'id','pdf_arxiv','https://arxiv.org/pdf/'||(value->>'arxiv'),
              CASE WHEN key%8<>0 THEN value->>'at' END FROM json_each(?) WHERE value->>'source'='arxiv'`,
                records,
              ),
            ]
          : []),
        db
          .prepare(
            `INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title,title_norm,topics,has_canonical)
          SELECT value->>'id',CASE WHEN value->>'source'='arxiv' THEN value->>'arxiv' END,value->>'doi',value->>'day',value->>'title',
            lower(value->>'title'),value->'topics',?2 FROM json_each(?1)`,
          )
          .bind(JSON.stringify(records), Number(full)),
        payload(
          `INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted)
          SELECT value->>'day',value->>'id',value->>'source',value->>'rank',value->'topics',value->>'shortlisted' FROM json_each(?)`,
          records,
        ),
        ...(full
          ? [
              payload(
                `INSERT INTO summaries(paper_id,lang,content,client,created_at)
          SELECT value->>'id','en',value->'summary','codex',value->>'at' FROM json_each(?1) WHERE value->>'summaryCount'>=1
          UNION ALL SELECT value->>'id','zh',json_set(value->'summary','$.tldr','方法与结果 '||json_extract(value,'$.summary.tldr')),
            'codex',value->>'at' FROM json_each(?1) WHERE value->>'summaryCount'=2`,
                records,
              ),
            ]
          : []),
      ]);
    }
    if (full) {
      const picks = [paperId(start), paperId(start + 11), paperId(start + 22)];
      const radar = [
        {
          paperId: paperId(start + 33),
          level: "high",
          reason: "Similar stereo setup",
        },
      ];
      await db.batch([
        db
          .prepare(
            "INSERT INTO digests(day,body_md,picks,radar,final,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
          )
          .bind(
            day,
            "## Stereo depth\n\nResults from the daily reading.",
            JSON.stringify(picks),
            JSON.stringify(radar),
            at,
            at,
          ),
        db
          .prepare(
            "INSERT INTO suggestions(id,day,kind,title,body_md,paper_ids,created_by) VALUES (?,?,'new_idea',?,?,?,'fixture')",
          )
          .bind(
            "sug_scale_" + day,
            day,
            "Compare stereo calibration",
            "Try the reported evaluation setup.",
            JSON.stringify(picks),
          ),
        db
          .prepare(
            "INSERT INTO radar_grades(id,day,paper_id,level,reason) VALUES (?,?,?,'high','Stereo baseline')",
          )
          .bind("rad_scale_" + day, day, radar[0]!.paperId),
      ]);
    }
  }

  const at = timestamp(newest);
  await db.batch([
    db
      .prepare(
        `INSERT INTO library_items(paper_id,status,tags,added_via,added_at,updated_at)
      SELECT id,CASE rowid%3 WHEN 0 THEN 'saved' WHEN 1 THEN 'reading' ELSE 'read' END,'["stereo"]','manual',?1,?1
      FROM papers ORDER BY id LIMIT 300`,
      )
      .bind(at),
    db
      .prepare(
        `INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,saved_at,synced_at)
      SELECT printf('00000000-0000-4000-8000-%012d',p.rowid),p.id,p.title,?1,?1
      FROM papers p JOIN library_items l ON l.paper_id=p.id WHERE p.rowid%4=0`,
      )
      .bind(at),
    db
      .prepare(
        `INSERT INTO paper_state(paper_id,starred,rating,updated_at)
      SELECT id,rowid%2,CASE rowid%3 WHEN 0 THEN 'up' ELSE 'none' END,? FROM papers ORDER BY id LIMIT 2000`,
      )
      .bind(at),
    db
      .prepare(
        `INSERT INTO events(id,paper_id,kind,day,source,at)
      SELECT 'evt_'||p.id,p.id,CASE p.rowid%5 WHEN 0 THEN 'rate_up' WHEN 1 THEN 'save' ELSE 'open' END,
        date(?1,printf('-%d day',p.rowid%45)),'web',date(?1,printf('-%d day',p.rowid%45))||'T08:00:00.000Z'
      FROM papers p JOIN paper_state s ON s.paper_id=p.id`,
      )
      .bind(newest),
    db
      .prepare(
        `INSERT INTO daily_runs(id,run_day,started_at,target_day,finished_at)
      SELECT 'scale-'||value,value,value||'T07:00:00.000Z',value,value||'T08:00:00.000Z' FROM json_each(?)`,
      )
      .bind(JSON.stringify(dates.slice(0, 96))),
  ]);

  const vault = Array.from({ length: vaultSize }, (_, i) => ({
    ...vaultNote(i, newest),
    fingerprint: hash("fingerprint " + i),
  }));
  for (let i = 0; i < vault.length; i += 50) {
    await db
      .prepare(
        `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
      SELECT value->>'id',value->>'path',value->>'kind',value->>'title',value->'frontmatter',
        value->>'hash',value->>'bodyHash',value->>'fingerprint',?2 FROM json_each(?1)`,
      )
      .bind(JSON.stringify(vault.slice(i, i + 50)), at)
      .run();
  }
  for (const [i, note] of vault.slice(0, 260).entries()) {
    const project = vault[i % 40]!.id;
    const ids = JSON.stringify([paperId(i * 2), paperId(i * 11)]);
    if (i < 40) {
      await db
        .prepare(
          "INSERT INTO projects(id,vault_note_id,slug,title,status,updated_at) VALUES (?,?,?,?,'active',?)",
        )
        .bind(note.id, note.id, "scale-" + i, note.title, at)
        .run();
    } else if (i < 240) {
      await db
        .prepare(
          "INSERT INTO idea_index(id,vault_note_id,title,status,description,project_id,paper_ids,updated_at) VALUES (?,?,?,'seed',?,?,?,?)",
        )
        .bind(
          note.id,
          note.id,
          note.title,
          "Check stereo depth under motion",
          project,
          ids,
          at,
        )
        .run();
    } else {
      const ideas = vault
        .slice(40 + (i - 240) * 5, 45 + (i - 240) * 5)
        .map(({ id }) => id);
      await db
        .prepare(
          "INSERT INTO working_paper_index(id,vault_note_id,title,status,project_id,paper_ids,idea_ids,updated_at) VALUES (?,?,?,'draft',?,?,?,?)",
        )
        .bind(
          note.id,
          note.id,
          note.title,
          project,
          ids,
          JSON.stringify(ideas),
          at,
        )
        .run();
    }
  }
  await db
    .prepare("UPDATE vault_sync SET snapshot=?,note_count=? WHERE id=1")
    .bind(hash("scale-initial"), vaultSize)
    .run();
  await db
    .prepare(
      `INSERT INTO vault_requests(id,kind,target_note_id,payload,base_hash,origin,created_at)
    VALUES ('req_scale_queued','link_paper',?,?,?,'cli',?)`,
    )
    .bind(
      vault[41]!.id,
      JSON.stringify({ paperId: paperId(11), title: "Stereo example" }),
      vault[41]!.hash,
      at,
    )
    .run();
  const month = newest.slice(0, 7);
  await payload(
    `INSERT INTO monthly_trends
    SELECT value->>'topic',value->>'month',400,35,2,4,'{"high":4,"medium":0,"borrow":0}',1,1,1,
      '[]','[]',json_array(value->>'first', value->>'second'),
      json_array(json_object('paperId',value->>'first','saved',1,'rating','up'))
      FROM json_each(?)`,
    subjects.flatMap(([topic]) =>
      Array.from({ length: 12 }, (_, i) => ({
        topic,
        month: shiftMonth(month, -i),
        first: paperId(i * 7000),
        second: paperId(i * 7000 + 11),
      })),
    ),
  ).run();
}
