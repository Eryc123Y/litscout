import { mkdirSync } from "node:fs";
import { shiftDay } from "@litscout/pipeline/daily";
import { scaleRuntime } from "./scale-runtime";

mkdirSync(".artifacts/m4i", { recursive: true });
const label = process.argv[2] ?? "scale";
const newest =
  process.argv[3] ?? shiftDay(new Date().toISOString().slice(0, 10), -1);
const local = await scaleRuntime(label, newest);
try {
  const counts = await local.db
    .prepare(
      `
    SELECT (SELECT count(*) FROM papers) AS full,
      (SELECT count(*) FROM paper_index WHERE has_canonical=0) AS compact,
      (SELECT count(*) FROM feed_items) AS occurrences,
      (SELECT count(*) FROM summaries) AS summaries,
      (SELECT note_count FROM vault_sync) AS vault
  `,
    )
    .first();
  console.log(JSON.stringify({ label, newest, ...counts }));
} finally {
  await local.worker.dispose();
}
