import SQLite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { ftsMigration, type FtsVariant } from "./fts-variants";
export function textGenerator() {
  let seed = 42;
  return (bytes: number) =>
    Array.from({ length: bytes }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return i % 8 === 7 ? " " : String.fromCharCode(97 + (seed % 26));
    }).join("");
}
export function fixture(i: number, text: (n: number) => string) {
  const title = text(84);
  const abstract = text(1362);
  const base = {
    tldr: "",
    motivation: "",
    method: "",
    result: "",
    conclusion: "",
  };
  return {
    id: `pap_synthetic_${i}`,
    title,
    abstract,
    summary: JSON.stringify({
      ...base,
      tldr: text(1211 - JSON.stringify(base).length),
    }),
    arxiv: `2611.${String(i).padStart(5, "0")}`,
    doi: `10.1234/synthetic.${i}`,
  };
}
function statements(db: SQLite.Database) {
  return {
    paper: db.prepare(
      "INSERT INTO papers(id,title,title_norm,abstract,authors) VALUES (?,?,?,?,?)",
    ),
    identifier: db.prepare("INSERT INTO paper_ids VALUES (?,?,?)"),
    link: db.prepare(
      "INSERT INTO paper_links(id,paper_id,kind,url) VALUES (?,?,?,?)",
    ),
    feed: db.prepare(
      "INSERT INTO feed_items(day,paper_id,source) VALUES ('2026-11-17',?,'arxiv')",
    ),
    summary: db.prepare("INSERT INTO summaries(paper_id,content) VALUES (?,?)"),
    index: db.prepare(
      "INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title) VALUES (?,?,?,'2026-11-17',?)",
    ),
  };
}
function write(
  s: ReturnType<typeof statements>,
  f: ReturnType<typeof fixture>,
  i: number,
) {
  s.paper.run(
    f.id,
    f.title,
    f.title.toLowerCase(),
    f.abstract,
    JSON.stringify([{ name: "Synthetic Author" }]),
  );
  s.identifier.run(f.id, "arxiv", f.arxiv);
  s.identifier.run(f.id, "doi", f.doi);
  s.link.run(`lnk_${i}_doi`, f.id, "doi", `https://doi.org/${f.doi}`);
  s.link.run(
    `lnk_${i}_pdf`,
    f.id,
    "pdf_arxiv",
    `https://arxiv.org/pdf/${f.arxiv}`,
  );
  s.feed.run(f.id);
  s.index.run(f.id, f.arxiv, f.doi, f.title);
}
const size = (db: SQLite.Database) =>
  Number(db.pragma("page_count", { simple: true })) *
  Number(db.pragma("page_size", { simple: true }));
const changes = (db: SQLite.Database) =>
  (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
export function estimateSize(count: number, variant: FtsVariant) {
  const db = new SQLite(":memory:");
  try {
    db.exec(readFileSync("packages/db/migrations/0001_schema.sql", "utf8"));
    db.exec(ftsMigration(variant));
    db.exec("VACUUM");
    const baseline = size(db);
    const before = changes(db);
    const s = statements(db);
    const text = textGenerator();
    let paperRows = 0,
      summaryRows = 0;
    db.prepare("INSERT INTO feed_days(day) VALUES ('2026-11-17')").run();
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const f = fixture(i, text),
          beforePaper = changes(db);
        write(s, f, i);
        paperRows += changes(db) - beforePaper;
        const beforeSummary = changes(db);
        s.summary.run(f.id, f.summary);
        summaryRows += changes(db) - beforeSummary;
      }
    })();
    db.exec("VACUUM");
    return {
      variant,
      papers: count,
      titleBytes: 84,
      abstractBytes: 1362,
      summaryBytes: 1211,
      incrementalBytes: size(db) - baseline,
      bytesPerPaper: (size(db) - baseline) / count,
      sqliteCommitRowsPerPaper:
        (changes(db) - before - 1 - paperRows - summaryRows) / count,
      sqlitePaperRowsPerPaper: paperRows / count,
      sqliteSummaryRowsPerSummary: summaryRows / count,
      sqliteRowsWrittenPerPaper: (changes(db) - before - 1) / count,
      note: "SQLite total_changes includes FTS trigger writes, excludes index writes; D1 billing must be measured on staging.",
    };
  } finally {
    db.close();
  }
}
