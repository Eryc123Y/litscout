import { expect, it, vi } from "vitest";
import { ApiFailure, apiClient, WriteBudget } from "../src/api";

// A write first reads the server's budget. When that read fails, the error
// names the cause in words this code wrote, so a scheduled job's log shows it.
const day = "2026-11-22";
const usage = {
  day,
  used: 100,
  reserved: 0,
  staleLeasesReleased: 0,
  limit: 80000,
  resetAt: "2026-11-23T00:00:00.000Z",
};
function failingWrite(fetcher: () => Promise<Response>) {
  const budget = new WriteBudget(
    { day, rows: 0 },
    () => new Date(day),
    async () => {},
    true,
  );
  const impl = vi.fn(fetcher);
  const api = apiClient(
    "https://local",
    "synthetic",
    impl as unknown as typeof fetch,
    budget,
    async () => {},
  );
  return {
    impl,
    failure: api.write("/ingest/feed-day", {}, 10).then(
      () => {
        throw new Error("the write was sent");
      },
      (error: unknown) => error,
    ),
  };
}

it("says the CLI and the server differ when the budget reply has a shape this CLI does not know", async () => {
  // What a CLI from before the instance write limit saw on 2026-11-22: the
  // server answered, but with a limit above anything that CLI accepted.
  const { impl, failure } = failingWrite(async () =>
    Response.json({
      success: true,
      data: { ...usage, limit: 20_000_000, baseLimit: 20_000_000 },
    }),
  );
  const error = await failure;
  expect(error).toBeInstanceOf(ApiFailure);
  const { message } = error as Error;
  expect(message).toContain("does not fit this CLI");
  expect(message).toContain("limit: ");
  expect(message).toContain("baseLimit: ");
  expect(message).toContain("different versions");
  expect(message).toContain("No writes sent");
  // Only the budget was read; the write never left.
  expect(impl).toHaveBeenCalledTimes(1);
});

it("names the HTTP status when the server refuses the budget read", async () => {
  const { failure } = failingWrite(
    async () => new Response("private upstream body", { status: 401 }),
  );
  const error = await failure;
  expect(error).toBeInstanceOf(ApiFailure);
  expect((error as Error).message).toContain(
    "Cannot read server budget (LitScout API HTTP 401); no writes sent.",
  );
  expect((error as Error).message).not.toContain("private upstream body");
});

it("says the server is unreachable without repeating the network error", async () => {
  const { failure } = failingWrite(async () => {
    throw new Error("private upstream diagnostic");
  });
  const error = await failure;
  expect(error).toBeInstanceOf(ApiFailure);
  expect((error as Error).message).toContain(
    "Cannot read server budget (LitScout API unreachable); no writes sent.",
  );
  expect((error as Error).message).not.toContain("private upstream");
});

it("gives a failed read its HTTP status as a displayable failure", async () => {
  const budget = new WriteBudget(
    { day, rows: 0 },
    () => new Date(day),
    async () => {},
  );
  const api = apiClient(
    "https://local",
    "synthetic",
    (async () => new Response("nope", { status: 403 })) as typeof fetch,
    budget,
    async () => {},
  );
  const error = await api.get("/feed/days").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiFailure);
  expect((error as Error).message).toBe("LitScout API HTTP 403");
});
