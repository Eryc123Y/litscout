import { expect, it } from "vitest";
import type SQLite from "better-sqlite3";
import { getWorkingPaper } from "../src/working-papers";
import { databaseHarness } from "./harness";

it("caps the reading list, takes each day's top candidates and ranks by title and topics before abstract ties", async () => {
  const { db, close } = await databaseHarness("sqlite");
  const sqlite = db.$client as SQLite.Database;
  const day = "2026-11-18";
  try {
    sqlite.exec(`
      INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES
        ('work','Work.md','working_paper','Working paper','{}','h','b','f','now'),
        ('idea','Idea.md','idea','Stereo depth calibration','{}','h','b','f','now');
      INSERT INTO idea_index(id,vault_note_id,title,status,paper_ids,updated_at)
      VALUES ('idea','idea','Stereo depth calibration','seed',json_array('existing-0'),'now');
      INSERT INTO working_paper_index(id,vault_note_id,title,idea_ids,paper_ids,updated_at)
      VALUES ('work','work','Working paper',json_array('idea'),'[]','now');
      WITH RECURSIVE nums(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM nums WHERE n<201)
      INSERT INTO papers(id,title,title_norm) SELECT 'existing-'||n,'Reference '||n,'reference '||n FROM nums;
      UPDATE idea_index SET paper_ids=(SELECT json_group_array(id) FROM
        (SELECT id FROM papers ORDER BY CAST(substr(id,10) AS INTEGER)));
      UPDATE papers SET title='Already reading stereo depth' WHERE id='existing-201';
      INSERT INTO feed_days(day) VALUES ('${day}');
      INSERT INTO papers(id,title,title_norm,abstract) VALUES
        ('primary','Stereo depth calibration','primary',''),
        ('late','Stereo analysis','late',printf('%.*c',600,'x')||' depth calibration'),
        ('early','Stereo method','early','depth'),
        ('unrelated','Publication','unrelated','Stereo depth calibration'),
        ('topic','Imaging','topic','');
      INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics) VALUES
        ('${day}','primary','arxiv',1,'[]'),
        ('${day}','late','arxiv',2,'[]'),
        ('${day}','early','arxiv',3,'[]'),
        ('${day}','unrelated','arxiv',4,'[]'),
        ('${day}','existing-201','arxiv',5,'[]'),
        ('${day}','topic','arxiv',6,'["Calibration"]'),
        ('${day}','existing-0','arxiv',7,'["Calibration"]');
      WITH RECURSIVE nums(n) AS (VALUES(8) UNION ALL SELECT n+1 FROM nums WHERE n<62)
      INSERT INTO papers(id,title,title_norm) SELECT 'filler-'||n,'Filler '||n,'filler '||n FROM nums;
      -- Within the day's 20 candidates once the two reading-list papers are skipped.
      UPDATE papers SET title='Stereo depth calibration' WHERE id='filler-19';
      UPDATE papers SET title='Stereo depth calibration' WHERE id='filler-30';
      INSERT INTO feed_items(day,paper_id,source,rank_in_source)
      SELECT '${day}',id,'arxiv',CAST(substr(id,8) AS INTEGER) FROM papers WHERE id LIKE 'filler-%';
      INSERT INTO papers(id,title,title_norm) VALUES ('too-late','Stereo depth calibration','too-late');
      INSERT INTO feed_items(day,paper_id,source,rank_in_source) VALUES ('${day}','too-late','arxiv',63);
    `);
    const result = await getWorkingPaper(db, "work", day);
    expect(result?.reading).toHaveLength(200);
    expect(result?.readingMore).toBe(2);
    expect(result?.reading.at(-1)?.id).toBe("existing-199");
    expect(result?.recent.map(({ id }) => id)).toEqual([
      "topic",
      "primary",
      "filler-19",
      "early",
      "late",
    ]);
  } finally {
    await close();
  }
});

it("keeps earlier days of the week in the candidates when today is busy", async () => {
  const { db, close } = await databaseHarness("sqlite");
  const sqlite = db.$client as SQLite.Database;
  const day = "2026-11-19";
  const earlier = "2026-11-16";
  try {
    sqlite.exec(`
      INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES
        ('work','Work.md','working_paper','Working paper','{}','h','b','f','now'),
        ('idea','Idea.md','idea','Stereo depth calibration','{}','h','b','f','now');
      INSERT INTO idea_index(id,vault_note_id,title,status,paper_ids,updated_at)
      VALUES ('idea','idea','Stereo depth calibration','seed','[]','now');
      INSERT INTO working_paper_index(id,vault_note_id,title,idea_ids,paper_ids,updated_at)
      VALUES ('work','work','Working paper',json_array('idea'),'[]','now');
      INSERT INTO feed_days(day) VALUES ('${day}'),('${earlier}');
      WITH RECURSIVE nums(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM nums WHERE n<100)
      INSERT INTO papers(id,title,title_norm) SELECT 'busy-'||n,'Unrelated topic '||n,'unrelated '||n FROM nums;
      INSERT INTO feed_items(day,paper_id,source,rank_in_source)
      SELECT '${day}',id,'arxiv',CAST(substr(id,6) AS INTEGER) FROM papers WHERE id LIKE 'busy-%';
      INSERT INTO papers(id,title,title_norm) VALUES ('match','Stereo depth calibration','match');
      INSERT INTO feed_items(day,paper_id,source,rank_in_source) VALUES ('${earlier}','match','arxiv',1);
    `);
    const result = await getWorkingPaper(db, "work", day);
    expect(result?.recent.map(({ id }) => id)).toContain("match");
  } finally {
    await close();
  }
});
