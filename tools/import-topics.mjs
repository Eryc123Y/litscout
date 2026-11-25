import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
const { importTopics } = await tsImport(
  "../packages/pipeline/src/topics.ts",
  import.meta.url,
);
if (!process.argv[2])
  throw new Error("Use node tools/import-topics.mjs <interest-presets.js>");
process.stdout.write(
  JSON.stringify(
    importTopics(await readFile(process.argv[2], "utf8")),
    null,
    2,
  ) + "\n",
);
