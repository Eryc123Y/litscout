import { z } from "zod";
import { ingestLimitsSchema } from "@litscout/core/ingest-limits";
import type { FeedApi } from "@litscout/pipeline/api";
import { ApiFailure } from "@litscout/pipeline/api-failure";
import type { PaperInput } from "@litscout/pipeline/contracts/index";
import {
  batchFor,
  fitBatch,
  payloadFor,
  writeOverhead,
} from "@litscout/pipeline/ingest-batching";
import { writeReservation } from "@litscout/pipeline/write-reservation";
import { shiftDay } from "@litscout/pipeline/daily";
import { storedLegacyLinks } from "@litscout/pipeline/legacy-links";
import { legacySteps, resolveDay } from "./legacy-upload";
import type { ImportCheckpoint, LegacyPlan } from "./legacy";

type PendingWrite = {
  path: string;
  body: Record<string, unknown>;
  method?: "POST" | "PUT";
  rows: number;
  /** IDs assigned by the write replace placeholders in later operations. */
  mappings?: Map<string, string>;
};

const quoteSchema = z.object({
  rows: z.number().int().nonnegative(),
  papers: z.array(
    z.object({
      key: z.string(),
      paperId: z.string().nullable(),
      summaryDays: z.number().int().nonnegative(),
      languages: z.array(z.string()),
      deleted: z.boolean().optional(),
    }),
  ),
});
type PaperFact = z.output<typeof quoteSchema>["papers"][number];
const defaultLimits = ingestLimitsSchema.parse({});

function datedGroups(plan: LegacyPlan) {
  const groups = new Map<string, LegacyPlan>();
  const source = new Map<string, { day: string; paper: PaperInput }>();
  const refs = new Map<string, Set<string>>();
  const dependencies = new Map<string, string>();
  const group = (day: string) => {
    if (!groups.has(day)) {
      groups.set(day, {
        ...plan,
        days: [],
        digests: [],
        radar: [],
        missed: [],
        ratings: [],
        runs: [],
        cursors: [],
      });
      refs.set(day, new Set());
    }
    return groups.get(day)!;
  };
  for (const d of plan.days) {
    group(d.day).days.push(d);
    for (const paper of d.papers)
      if (!source.has(paper.key)) source.set(paper.key, { day: d.day, paper });
    for (const summary of d.summaries) refs.get(d.day)!.add(summary.key);
  }
  const dateFor = (day: string, keys: string[]) => {
    const through = keys.reduce((end, key) => {
      const date = source.get(key)?.day;
      return date && date > end ? date : end;
    }, day);
    group(day);
    group(through);
    if (through > (dependencies.get(day) ?? day))
      dependencies.set(day, through);
    for (const key of keys) refs.get(through)!.add(key);
    return through;
  };
  for (const digest of plan.digests) {
    const keys = [...source.keys()].filter(
      (key) =>
        digest.bodyMd.includes(key) ||
        digest.bodyMd.includes(encodeURIComponent(key)),
    );
    keys.push(
      ...plan.ledger
        .filter((item) => item.day === digest.day)
        .map((item) => item.key),
    );
    group(dateFor(digest.day, keys)).digests.push(digest);
  }
  for (const item of plan.radar)
    group(dateFor(item.day, [item.key])).radar.push(item);
  for (const item of plan.missed)
    group(dateFor(item.day, [item.key])).missed.push(item);
  for (const item of plan.ratings)
    group(dateFor(item.day, [item.key])).ratings.push(item);
  for (const run of plan.runs) group(run.day).runs.push(run);
  return {
    groups: [...groups].sort(([a], [b]) => a.localeCompare(b)),
    refs,
    source,
    dependencies,
  };
}

function batches(api: FeedApi, path: string, body: Record<string, unknown>) {
  const limits = api.ingestLimits ?? defaultLimits;
  const batch = batchFor(path, body, limits);
  if (!batch) return [body];
  const parts = [];
  for (let offset = 0; offset < batch.rows.length;) {
    const payload = (size: number) => payloadFor(batch, offset, size);
    const size = fitBatch(
      Math.min(batch.cap, batch.rows.length - offset),
      limits.bytes,
      payload,
    );
    parts.push(payload(size));
    offset += size;
  }
  return parts;
}
const bound = (api: FeedApi, path: string, body: Record<string, unknown>) =>
  api.planRows?.(path, body, "batched") ??
  writeReservation(path, body) + writeOverhead;

async function inspect(api: FeedApi, day: string, papers: unknown[]) {
  if (!api.inspectLegacyPapers) return null;
  return quoteSchema.parse(
    await api.inspectLegacyPapers({ day, papers, legacy: "plan" }),
  );
}

function freshPaperBound(paper: PaperInput) {
  return (
    12 +
    Number(paper.venue !== null) +
    Number(!paper.abstract?.trim()) +
    Number(paper.shortlisted) +
    new Set(paper.topics).size +
    2 * paper.identifiers.length +
    3 * storedLegacyLinks(paper).length
  );
}

function planner(api: FeedApi) {
  const writes: PendingWrite[] = [];
  const facts = new Map<string, PaperFact>();
  let placeholder = 0;
  const client: FeedApi = {
    get: api.get,
    async write(path, input, _rows, method) {
      const body = input as Record<string, unknown>;
      const mappings = new Map<string, string>();
      // Metadata helpers can emit empty batches after dropping unresolved keys.
      const rows = Object.values(body).filter(Array.isArray);
      if (
        path.startsWith("/ingest/") &&
        rows.length &&
        rows.every((part) => !part.length)
      )
        return {};
      const quoted = path === "/ingest/papers" || path === "/ingest/summaries";
      for (const part of batches(
        api,
        path,
        quoted ? { ...body, maxRows: 99_999_999 } : body,
      )) {
        let expected: Map<string, string> | undefined;
        if (path === "/ingest/papers") {
          const papers = part.papers as PaperInput[];
          const quote = await inspect(api, String(part.day), papers);
          part.maxRows =
            quote?.rows ??
            papers.reduce((sum, paper) => sum + freshPaperBound(paper), 3);
          for (const item of quote?.papers ??
            papers.map(({ key }) => ({
              key,
              paperId: null,
              summaryDays: 1,
              languages: [],
              deleted: false,
            }))) {
            if (item.deleted) continue;
            const id =
              item.paperId ?? "pap_" + String(placeholder++).padStart(26, "0");
            facts.set(id, item);
            mappings.set(item.key, id);
          }
          if (quote?.rows === 0 && quote.papers.length === papers.length)
            continue;
          expected = new Map(
            papers.flatMap(({ key }) =>
              mappings.has(key) ? [[key, mappings.get(key)!] as const] : [],
            ),
          );
        } else if (path === "/ingest/summaries") {
          const summaries = (
            part.summaries as { paperId: string; lang: string }[]
          ).filter(
            ({ paperId, lang }) =>
              !facts.get(paperId)?.languages.includes(lang),
          );
          if (!summaries.length) continue;
          part.summaries = summaries;
          part.maxRows =
            5 * summaries.length +
            [...new Set(summaries.map((s) => s.paperId))].reduce(
              (sum, id) => sum + (facts.get(id)?.summaryDays ?? 1),
              0,
            );
        }
        writes.push({
          path,
          body: part,
          method,
          rows: bound(api, path, part),
          mappings: expected,
        });
      }
      return path === "/ingest/papers"
        ? { papers: [...mappings].map(([key, paperId]) => ({ key, paperId })) }
        : {};
    },
  };
  return { client, writes, facts };
}

const mappingSchema = z.object({
  papers: z.array(z.object({ key: z.string(), paperId: z.string() })),
});
function useRealIds(write: PendingWrite, ids: Map<string, string>) {
  const body = { ...write.body };
  if (Array.isArray(body.picks))
    body.picks = body.picks.map((id: string) => ids.get(id) ?? id);
  for (const key of ["summaries", "radar", "missed", "ratings"]) {
    const values = body[key] as { paperId: string }[] | undefined;
    if (values)
      body[key] = values.map((value) => ({
        ...value,
        paperId: ids.get(value.paperId) ?? value.paperId,
      }));
  }
  return body;
}

function admissionUnits(
  groups: ReturnType<typeof datedGroups>["groups"],
  dependencies: Map<string, string>,
) {
  const units: (typeof groups)[] = [];
  for (let start = 0; start < groups.length;) {
    let end = start;
    let through = groups[start]![0];
    while (end < groups.length && groups[end]![0] <= through) {
      const linked = dependencies.get(groups[end]![0]);
      if (linked && linked > through) through = linked;
      end++;
    }
    units.push(groups.slice(start, end));
    start = end;
  }
  return units;
}

function estimateUnit(unit: ReturnType<typeof datedGroups>["groups"]) {
  return unit.reduce(
    (total, [, { days, digests, ratings, missed, radar, runs }]) =>
      total +
      25 +
      39 * digests.length +
      8 * (ratings.length + missed.length + radar.length + runs.length) +
      days.reduce(
        (sum, { papers, summaries }) =>
          sum +
          papers.reduce((n, paper) => n + freshPaperBound(paper), 0) +
          summaries.length * 6 +
          writeOverhead *
            (Math.ceil(papers.length / defaultLimits.papers) +
              Math.ceil(summaries.length / defaultLimits.summaries)),
        0,
      ),
    0,
  );
}

function projectFinish(today: string, limit: number, costs: number[]) {
  if (!costs.length) return today;
  if (limit === 0 || costs.some((cost) => cost > limit)) return null;
  let windows = 1;
  let left = limit;
  for (const cost of costs) {
    if (cost > left) {
      windows++;
      left = limit;
    }
    left -= cost;
  }
  return shiftDay(today, windows);
}

async function prepareReferences(
  api: FeedApi,
  unit: ReturnType<typeof datedGroups>["groups"],
  { refs, source }: ReturnType<typeof datedGroups>,
  ids: Map<string, string>,
  facts: Map<string, PaperFact>,
) {
  const local = new Set(
    unit.flatMap(([, { days }]) =>
      days.flatMap(({ papers }) => papers.map(({ key }) => key)),
    ),
  );
  const summaries = new Set(
    unit.flatMap(([, { days }]) =>
      days.flatMap((day) => day.summaries.map(({ key }) => key)),
    ),
  );
  const keys = new Set(unit.flatMap(([day]) => [...(refs.get(day) ?? [])]));
  const lookupsByDay = new Map<string, unknown[]>();
  for (const key of keys) {
    const original = source.get(key);
    if (!original || local.has(key) || (ids.has(key) && !summaries.has(key)))
      continue;
    const papers = lookupsByDay.get(original.day) ?? [];
    papers.push(original.paper);
    lookupsByDay.set(original.day, papers);
  }
  for (const [day, papers] of lookupsByDay) {
    if (!api.inspectLegacyPapers) {
      await resolveDay(api, day, ids);
      continue;
    }
    for (const part of batches(api, "/ingest/papers", {
      day,
      papers,
      legacy: "plan",
    })) {
      const quote = await inspect(api, day, part.papers as unknown[]);
      for (const fact of quote?.papers ?? []) {
        if (!fact.paperId || fact.deleted) continue;
        ids.set(fact.key, fact.paperId);
        facts.set(fact.paperId, fact);
      }
    }
  }
}

async function applyUnit(
  api: FeedApi,
  writes: PendingWrite[],
  ids: Map<string, string>,
) {
  const replacements = new Map<string, string>();
  for (const write of writes) {
    const response = await api.write(
      write.path,
      useRealIds(write, replacements),
      write.rows,
      write.method,
      true,
    );
    if (!write.mappings?.size) continue;
    const returned = new Map(
      mappingSchema
        .parse(response)
        .papers.map(({ key, paperId }) => [key, paperId]),
    );
    for (const [key, expected] of write.mappings) {
      const actual = returned.get(key);
      if (!actual)
        throw new Error(
          "Legacy identity changed during import. Retry with the same dates.",
        );
      replacements.set(expected, actual);
    }
  }
  for (const [key, value] of ids)
    ids.set(key, replacements.get(value) ?? value);
}

export async function importLegacyDates(
  plan: LegacyPlan,
  api: FeedApi,
  tracedApi: FeedApi,
  name: string,
  state: NonNullable<ImportCheckpoint["state"]> & { runId: string },
  report: Record<string, unknown>,
  now: Date,
  maxRows?: number,
  checkpoint?: ImportCheckpoint,
  keepRows?: number,
) {
  const dated = datedGroups(plan);
  const { groups, dependencies } = dated;
  const units = groups.length ? admissionUnits(groups, dependencies) : [[]];
  const originalComplete =
    !state.version && state.offset >= legacySteps(plan, api).length + 1;
  const offset =
    state.version === 2 ? state.offset : originalComplete ? units.length : 0;
  const ids = new Map<string, string>();
  let planned = 0,
    peak = 0,
    completed = offset,
    next: number | undefined;
  const startingRows = api.writeRows?.() ?? 0;
  const used = () => (api.writeRows ? api.writeRows() - startingRows : planned);
  const wanted = offset < units.length && maxRows !== 0;
  // Keeping a reserve needs the live balance: without it, import nothing.
  const { budget, reason: budgetReason } = !wanted
    ? {}
    : keepRows === undefined
      ? { budget: await api.readBudget?.() }
      : await Promise.resolve(api.readBudget?.()).then(
          (value) => ({ budget: value, reason: undefined }),
          (error: unknown) => ({
            budget: undefined,
            // Shown in the result so a scheduled job's log says why.
            reason: error instanceof ApiFailure ? error.message : undefined,
          }),
        );
  const budgetUnread = wanted && keepRows !== undefined && !budget;
  const limit = Math.min(
    maxRows ?? Infinity,
    budget
      ? Math.max(
          0,
          budget.limit - budget.used - budget.reserved - (keepRows ?? 0),
        )
      : budgetUnread
        ? 0
        : Infinity,
  );
  const today = now.toISOString().slice(0, 10);
  for (let index = offset; index < units.length; index++) {
    if (used() >= limit) break;
    const unit = units[index]!;
    const final = index === units.length - 1;
    const preparation = planner(api);
    const provisional = new Map(ids);
    await prepareReferences(api, unit, dated, provisional, preparation.facts);
    for (const [, group] of unit)
      for (const step of legacySteps(
        group,
        preparation.client,
        provisional,
        true,
      ))
        await step();
    const saved = {
      offset: index + 1,
      runId: state.runId,
      version: 2 as const,
    };
    const run = {
      ...report,
      id: state.runId,
      kind: "legacy_import",
      day: today,
      status: "done",
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
    };
    await preparation.client.write(
      "/ingest/legacy",
      {
        cursors: [
          ...(final ? plan.cursors : []),
          { name, value: JSON.stringify(saved) },
        ],
        ...(final ? { runs: [run] } : {}),
      },
      0,
    );
    next = preparation.writes.reduce((sum, write) => sum + write.rows, 0);
    if (used() + next > limit) break;
    peak = Math.max(peak, used() + next);
    await applyUnit(tracedApi, preparation.writes, provisional);
    await checkpoint?.save(saved);
    for (const [key, paperId] of provisional) ids.set(key, paperId);
    planned += next;
    completed++;
    next = undefined;
  }
  const dates = (start: number, end?: number) =>
    units.slice(start, end).flatMap((unit) => unit.map(([day]) => day));
  const costs = units
    .slice(completed)
    .map(
      (unit, index) =>
        (index === 0 ? next : undefined) ??
        estimateUnit(unit) + (completed + index === units.length - 1 ? 16 : 0),
    );
  return {
    status:
      completed >= units.length
        ? "done"
        : budgetUnread
          ? "budget-unread"
          : "max-rows",
    operations: units.length,
    completedOperations: completed,
    rowsBudgeted: peak,
    rowsUsed: used(),
    daysImported: dates(offset, completed),
    daysLeft: dates(completed),
    projectedFinishDate: projectFinish(today, limit, costs),
    ...(budgetUnread ? { budgetUnread: true } : {}),
    ...(budgetUnread && budgetReason ? { budgetReason } : {}),
  };
}
