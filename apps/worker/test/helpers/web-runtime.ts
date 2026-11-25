import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { migrationStatements } from "@litscout/db/test/harness";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { ingestSummaryRecords } from "@litscout/db/ingest-records";
import { ingestFeedDay, ingestDigest } from "@litscout/db/ingest";
import { z } from "zod";
import { putTrends } from "@litscout/db/trends";
import { shiftMonth } from "@litscout/pipeline/trends-contracts";
import { seedResearch } from "./web-research";
import { seedReview } from "./web-review";
import { seedLongBrief } from "./web-long-brief";
const recorded = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    authors: z.array(z.string()),
    summary: z.string().optional(),
    abstract: z.string().nullable().optional(),
    venue: z.string().optional(),
    source: z.string().optional(),
    doi: z.string().optional(),
    categories: z.array(z.string()).optional(),
  }),
);
function recordedPaper(p: z.infer<typeof recorded>[number], i: number) {
  return {
    key: p.id,
    title: p.title,
    abstract: p.summary ?? p.abstract ?? null,
    authors: p.authors,
    source: i === 0 ? "arxiv" : "journal",
    venue: p.venue ?? null,
    venueKind: i === 0 ? "preprint" : "journal",
    categories: p.categories ?? [],
    identifiers: [
      {
        scheme: p.id.startsWith("doi:") ? "doi" : "arxiv",
        value: p.id.replace(/^doi:/, ""),
      },
    ],
    links: [
      {
        kind: "landing",
        url: p.id.startsWith("doi:")
          ? `https://doi.org/${p.id.slice(4)}`
          : `https://arxiv.org/abs/${p.id}`,
      },
    ],
    topics: [i === 0 ? "Language" : "Vision"],
    // Every fixture paper has a topic, so all are on the reader's topics (as
    // in real data); `unmatchedFixture` adds one that is not.
    shortlisted: true,
    hfUpvotes: i === 1 ? 24 : null,
  };
}
async function migrateWeb(db: D1Database) {
  for (const sql of migrationStatements()) await db.prepare(sql).run();
}
export async function seedWeb(db: D1Database) {
  await migrateWeb(db);
  const records = recorded.parse(
    JSON.parse(
      readFileSync("apps/web/test/fixtures/recorded-papers.json", "utf8"),
    ),
  );
  const result = await ingestPapers(
    db,
    "2026-11-17",
    records.map(recordedPaper),
  );
  if (result.invalid.length) throw new Error(JSON.stringify(result.invalid));
  await seedSummaries(db, result.papers);
  await seedDigest(db, result.papers);
  await seedPrivate(db, result.papers);
  return result.papers;
}
type PaperRefs = Awaited<ReturnType<typeof ingestPapers>>["papers"];
export const unmatchedTitle = "Outside Every Topic: A Fixture Paper";
async function seedUnmatched(db: D1Database) {
  const result = await ingestPapers(db, "2026-11-17", [
    {
      ...recordedPaper(
        {
          id: "2611.99001",
          title: unmatchedTitle,
          authors: ["Fixture Author"],
          summary: "A paper that matches none of the reader's topics.",
          categories: ["cs.DL"],
        },
        0,
      ),
      topics: [],
      shortlisted: false,
    },
  ]);
  if (result.invalid.length) throw new Error(JSON.stringify(result.invalid));
}
async function seedSummaries(db: D1Database, papers: PaperRefs) {
  await ingestSummaryRecords(db, {
    summaries: papers.map((p) => ({
      paperId: p.paperId,
      lang: "en",
      content: {
        tldr: "A recorded paper for today's reading.",
        motivation: "Understand the research problem.",
        method: "Compare the proposed method using the reported setup.",
        result: "Read the original paper for the measured evidence.",
        conclusion: "A synthetic summary for interface testing.",
      },
      client: "PRIVATE_CLIENT",
      model: "PRIVATE_MODEL",
    })),
  });
}
async function seedDigest(db: D1Database, papers: PaperRefs) {
  await ingestFeedDay(db, {
    day: "2026-11-17",
    status: "final",
    counts: { total: 3, arxiv: 1, venues: 2, PRIVATE_COUNT: 999 },
  });
  await ingestFeedDay(db, { day: "2026-11-16", status: "empty", counts: {} });
  await ingestFeedDay(db, { day: "2026-11-18", status: "pending", counts: {} });
  await ingestDigest(
    db,
    {
      day: "2026-11-17",
      lang: "en",
      bodyMd:
        "## Radar\n\nPRIVATE_RADAR_BRIEF: no high-confidence collision.\n\n## Vision\n\nA recorded reading pick.\n\n## Idea suggestions\n\nPRIVATE_IDEA_SUGGESTION: compare the two recorded papers as a possible baseline.\n\n[Safe link](https://example.org)\n\n[Unsafe link](javascript:alert)\n\n<script>window.injected=true</script>",
      picks: papers.map((p) => p.paperId),
      radar: [
        {
          paperId: papers[1]!.paperId,
          level: "borrow",
          fullTextRead: false,
          reason:
            "PRIVATE_RADAR: compare this recorded paper with the current reading question.",
          action: "Review its reported method before using it.",
        },
      ],
      final: true,
    },
    true,
  );
}
async function seedPrivate(db: D1Database, papers: PaperRefs) {
  const id = papers[0]!.paperId;
  await db
    .prepare(
      "INSERT INTO notes(id,user_id,target_type,target_id,body_md,origin) VALUES ('note_private','u_owner','paper',?,'PRIVATE_NOTE','web')",
    )
    .bind(id)
    .run();
  await db
    .prepare(
      "INSERT INTO paper_state(user_id,paper_id,rating) VALUES ('u_owner',?,'up')",
    )
    .bind(id)
    .run();
}
type RuntimeOptions = {
  assets?: string;
  port?: number;
  tls?: { key: string; cert: string };
  /** Run the built bundle against an empty database for the CLI rehearsal. */
  empty?: { scriptPath: string };
  publicFeed?: boolean;
  localDev?: boolean;
  researchFixtures?: boolean;
  reviewFixtures?: boolean;
  longBriefFixture?: boolean;
  /** One more 2026-11-17 paper that matches none of the reader's topics. */
  unmatchedFixture?: boolean;
  trendsFixtures?: boolean;
  mcp?: { origin: string; managementToken: string; researchTools: boolean };
  outboundService?: (request: Request) => Response | Promise<Response>;
  /** Turn the public read limiter off (local end-to-end server only). */
  publicLimitOff?: boolean;
  /** Turn the export cooldown off (local end-to-end server only). */
  backupCooldownOff?: boolean;
};
export async function webRuntime(options: RuntimeOptions = {}) {
  const worker = options.empty
    ? { scriptPath: options.empty.scriptPath }
    : { script: await compileWebWorker() };
  const mf = new Miniflare(
    convertV4MiniflareOptions(runtimeOptions(options, worker)),
  );
  try {
    const db = await mf.getD1Database("DB");
    if (options.empty) {
      await migrateWeb(db);
    } else {
      const papers = await seedWeb(db);
      if (options.trendsFixtures) await seedTrends(db, papers);
      if (options.researchFixtures)
        await seedResearch(db, papers, options.reviewFixtures);
      if (options.reviewFixtures) await seedReview(db);
      if (options.longBriefFixture) await seedLongBrief(db);
      if (options.unmatchedFixture) await seedUnmatched(db);
    }
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
async function seedTrends(db: D1Database, papers: PaperRefs) {
  const month = "2026-11";
  const saved = (paperId: string) => ({
    paperId,
    saved: true,
    rating: "up" as const,
  });
  await putTrends(db, [
    {
      topic: "Language",
      month,
      volume: 120,
      shortlisted: 24,
      radar: { high: 1, medium: 1, borrow: 4 },
      picks: [papers[0]!.paperId],
      activity: [saved(papers[0]!.paperId)],
      recurring: [{ term: "benchmarks", count: 12, score: 14 }],
      rising: [],
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      topic: "Vision",
      month: shiftMonth(month, -index),
      volume: 222 - index * 12,
      shortlisted: 38 - index * 2,
      radar: { high: 1, medium: index % 4, borrow: 6 },
      picks:
        index % 4 === 3
          ? [papers[1]!.paperId]
          : [papers[1]!.paperId, papers[2]!.paperId],
      activity: [saved(papers[1]!.paperId)],
      recurring: [
        { term: "transformers", count: 41, score: 52 },
        { term: "gaze", count: 26, score: 31 },
        { term: "rendering", count: 19, score: 22 },
      ],
      rising: [{ term: "aliasing", count: 12, score: 2.45 }],
    })),
  ]);
}

async function compileWebWorker() {
  const { outputFiles } = await build({
    entryPoints: ["apps/worker/src/index.ts"],
    write: false,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: '"local-test"' },
  });
  return outputFiles[0]!.text;
}
function runtimeOptions(
  options: RuntimeOptions,
  worker: { script: string } | { scriptPath: string },
) {
  return {
    modules: true,
    ...worker,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    host: "127.0.0.1",
    ...(options.tls && {
      https: true,
      httpsKey: options.tls.key,
      httpsCert: options.tls.cert,
    }),
    ...(options.port ? { port: options.port } : {}),
    d1Databases: ["DB"],
    kvNamespaces: ["OAUTH_KV"],
    durableObjects: {
      PAIRING_STORE: { className: "PairingStore", useSQLite: true },
      SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
    },
    ...assetOptions(options.assets),
    bindings: runtimeBindings(options),
    outboundService:
      options.outboundService ??
      (() => new Response("Network disabled", { status: 503 })),
  };
}
function assetOptions(assets: string | undefined) {
  return assets
    ? {
        assets: {
          directory: assets,
          binding: "ASSETS",
          run_worker_first: true,
          routerConfig: { has_user_worker: true },
        },
      }
    : {};
}
function runtimeBindings(options: RuntimeOptions) {
  return {
    PUBLIC_URL: options.mcp?.origin ?? "http://127.0.0.1:4173",
    ...(options.mcp && {
      MGMT_TOKEN: options.mcp.managementToken,
      CONSENT_SECRET: "fixture-consent-secret".repeat(2),
      MCP_RESEARCH_TOOLS: String(options.mcp.researchTools),
      S2_API_KEY: "fixture-key",
    }),
    LOCAL_DEV: String(options.localDev ?? true),
    ...(options.publicLimitOff ? { PUBLIC_RATE_LIMIT: "off" } : {}),
    ...(options.backupCooldownOff ? { BACKUP_COOLDOWN: "off" } : {}),
    PUBLIC_FEED: String(options.publicFeed ?? true),
    INSTANCE_CONFIG: JSON.stringify({
      name: "LitScout",
      language: "en",
      timezone: "Asia/Shanghai",
      topics: ["Vision", "Language"],
    }),
  };
}
