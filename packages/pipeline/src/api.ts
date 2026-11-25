import { z } from "zod";
import { WriteBudget } from "./budget";
export { WriteBudget, BudgetStop, budgetSchema } from "./budget";
import { ApiFailure } from "./api-failure";
export { ApiFailure };
import { quotaFailure } from "./quota";
import { adaptiveWrite } from "./adaptive-write";
import {
  ingestLimitsSchema,
  INGEST_CAPS,
  type IngestLimits,
} from "@litscout/core/ingest-limits";
import {
  BatchRetry,
  RejectedBatch,
  connectionFailure,
  plannedWriteRows,
  type PlanMode,
  type BatchingReport,
} from "./ingest-batching";
export interface FeedApi {
  batching?: BatchingReport;
  ingestLimits?: IngestLimits;
  writeRows?(): number;
  inspectLegacyPapers?(body: unknown): Promise<unknown>;
  readBudget?(): ReturnType<WriteBudget["synchronize"]>;
  planRows?(path: string, body: unknown, conservative?: PlanMode): number;
  get(path: string): Promise<unknown>;
  write(
    path: string,
    body: unknown,
    estimate: number,
    method?: "POST" | "PUT",
    strict?: boolean,
  ): Promise<unknown>;
}
const envelope = z.object({
  success: z.literal(true),
  data: z.unknown(),
  meta: z
    .object({
      rowsWritten: z.number().int().nonnegative().optional(),
      authRowsWritten: z.number().int().nonnegative().default(0),
      budgetRowsWritten: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type RequestOptions = {
  base: string;
  token: string;
  impl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};
async function requestApi(
  options: RequestOptions,
  path: string,
  method: string,
  body?: unknown,
  strict = false,
) {
  const { base, token, impl, sleep } = options;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const bytes =
    serialized === undefined
      ? 0
      : new TextEncoder().encode(serialized).byteLength;
  const maximum =
    path.startsWith("/ingest/") ||
    (method === "PUT" && /^\/digests\/[^/]+$/.test(path))
      ? INGEST_CAPS.bytes
      : 1024 * 1024;
  let uncertain = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await impl(new URL(`/api/v1${path}`, base), {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(serialized !== undefined ? { body: serialized } : {}),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      if (method !== "GET") throw connectionFailure(error, bytes, maximum);
      uncertain = true;
      if (attempt === 2) throw new ApiFailure("LitScout API unreachable");
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status === 429) throw await quotaFailure(response, uncertain);
    if (method !== "GET" && !response.ok) {
      const detail = await response.clone().text();
      if (
        response.status === 503 ||
        /1102|exceeded CPU|exceeded resource limits/i.test(detail)
      )
        throw new BatchRetry(
          response.status === 503 ? "HTTP 503" : "Cloudflare resource limit",
        );
    }
    if (response.status >= 500 && attempt < 2 && !strict) {
      if (response.status >= 500) uncertain = true;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      const reason = `LitScout API HTTP ${response.status}`;
      if (method !== "GET") {
        if (response.status >= 500 || [408, 425].includes(response.status))
          throw new BatchRetry(reason);
        if (
          path === "/ingest/papers" &&
          response.status >= 400 &&
          response.status < 500 &&
          ![401, 403, 404, 405, 407, 410].includes(response.status)
        )
          throw new RejectedBatch(reason);
      }
      throw new ApiFailure(reason);
    }
    return { ...envelope.parse(await response.json()), uncertain };
  }
  throw new ApiFailure("LitScout API unreachable");
}
export function apiClient(
  base: string,
  token: string,
  impl: typeof fetch,
  budget: WriteBudget,
  sleep = wait,
  limits?: Partial<IngestLimits>,
) {
  const ingest = ingestLimitsSchema.parse(limits ?? {});
  const batching: BatchingReport = {
    requests: [],
    retries: 0,
    rowsWritten: 0,
    failures: [],
  };
  const request = (
    path: string,
    method: string,
    body?: unknown,
    strict = false,
  ) => requestApi({ base, token, impl, sleep }, path, method, body, strict);
  let written = 0;
  let initialBudget: Promise<unknown> | undefined;
  const readBudget = () =>
    request("/budget", "GET")
      .then((r) => budget.synchronize(r.data))
      .catch((error: unknown) => {
        throw new ApiFailure(budget.unreadMessage(error));
      });
  const refreshBudget = () => (initialBudget = readBudget());
  return {
    batching,
    ingestLimits: ingest,
    writeRows: () => written,
    inspectLegacyPapers: async (body: unknown) =>
      (await request("/ingest/papers", "POST", body, true)).data,
    readBudget: refreshBudget,
    planRows: (path: string, body: unknown, conservative?: PlanMode) =>
      plannedWriteRows(path, body, ingest, conservative),
    get: async (path: string) => {
      if (path === "/budget") return refreshBudget();
      await budget.begin(2);
      try {
        const response = await request(path, "GET");
        await budget.settle(
          (response.meta?.authRowsWritten ?? 0) +
            (response.meta?.budgetRowsWritten ?? 0),
          2,
          response.uncertain,
        );
        return response.data;
      } catch (error) {
        await budget.settle(0, 2, false);
        throw error;
      }
    },
    write: async (
      path: string,
      body: unknown,
      estimate: number,
      method: "POST" | "PUT" = "POST",
      strict = false,
    ) => {
      // readBudget rejects with the reason, already in displayable words.
      if (budget.authoritative) await (initialBudget ??= readBudget());
      return adaptiveWrite(
        path,
        body,
        estimate,
        method,
        async (path, method, body) => {
          const reply = await request(path, method, body, strict);
          written +=
            (reply.meta?.rowsWritten ?? 0) +
            (reply.meta?.authRowsWritten ?? 0) +
            (reply.meta?.budgetRowsWritten ?? 0);
          return reply;
        },
        budget,
        ingest,
        batching,
        strict,
      );
    },
  };
}
export function chunks<T>(values: readonly T[], size = 100): T[][] {
  z.number().int().min(1).max(100).parse(size);
  return Array.from({ length: Math.ceil(values.length / size) }, (_, i) =>
    values.slice(i * size, (i + 1) * size),
  );
}
