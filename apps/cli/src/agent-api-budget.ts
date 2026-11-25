import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentApiConfig } from "@litscout/core/agent-config";
import type { SetupDeps } from "./command-types";
import { withFlowLock } from "./feed-lock";
import { privateJson } from "./state";

const tallySchema = z.strictObject({
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
type Tally = z.output<typeof tallySchema>;
type Reservation = { day: string; tokens: number };
export class ApiBudgetShort extends Error {}

async function readTally(file: string): Promise<Tally> {
  const raw = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  return raw === null
    ? { requests: 0, tokens: 0 }
    : tallySchema.parse(JSON.parse(raw));
}

export function apiBudget(deps: SetupDeps, config: AgentApiConfig) {
  const dir = deps.cacheDir ?? path.join(deps.dir, "cache");
  const run: Tally = { requests: 0, tokens: 0 };
  let stop: ApiBudgetShort | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  // Serialize parallel chunks within this command, and lock each cache update
  // across processes. A crashed command leaves its reservation charged.
  function update<T>(
    work: (tally: Tally, file: string, day: string) => Promise<T>,
    reservedDay?: string,
  ) {
    const operation = tail.then(() =>
      withFlowLock(
        { dir },
        async () => {
          const day =
            reservedDay ??
            (deps.flow?.now?.() ?? new Date()).toISOString().slice(0, 10);
          const file = path.join(dir, `agent-api-${day}.json`);
          return work(await readTally(file), file, day);
        },
        "agent-api.lock",
      ),
    );
    tail = operation.catch(() => {});
    return operation;
  }
  return {
    reserve(tokens: number) {
      return update(async (daily, file, day): Promise<Reservation> => {
        if (stop) throw stop;
        const limits = [
          {
            period: "daily",
            tally: daily,
            requests: config.maxRequestsPerDay,
            tokens: config.maxTokensPerDay,
          },
          {
            period: "run",
            tally: run,
            requests: config.maxRequestsPerRun ?? config.maxRequestsPerDay,
            tokens: config.maxTokensPerRun ?? config.maxTokensPerDay,
          },
        ];
        for (const limit of limits) {
          const kind =
            limit.tally.requests >= limit.requests
              ? "request"
              : limit.tally.tokens + tokens > limit.tokens
                ? "token"
                : null;
          if (kind) {
            stop = new ApiBudgetShort(
              `API ${limit.period} ${kind} cap cannot fit another call.`,
            );
            throw stop;
          }
        }
        await privateJson(file, {
          requests: daily.requests + 1,
          tokens: daily.tokens + tokens,
        });
        run.requests++;
        run.tokens += tokens;
        return { day, tokens };
      });
    },
    settle(reservation: Reservation, actualTokens: number) {
      const delta = actualTokens - reservation.tokens;
      return update(async (daily, file) => {
        await privateJson(file, { ...daily, tokens: daily.tokens + delta });
        run.tokens += delta;
      }, reservation.day);
    },
  };
}
