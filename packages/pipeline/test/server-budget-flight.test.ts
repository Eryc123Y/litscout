import { expect, it, vi } from "vitest";
import { WriteBudget, apiClient } from "../src/api";

it("uses the synchronized limit until UTC rollover", async () => {
  const day = "2026-11-17";
  let now = new Date(day);
  const budget = new WriteBudget(
    { day, rows: 0 },
    () => now,
    async () => {},
  );
  await budget.synchronize({
    day,
    used: 74000,
    reserved: 0,
    staleLeasesReleased: 0,
    limit: 75000,
    resetAt: "2026-11-18T00:00:00.000Z",
  });
  expect(budget.remaining()).toBe(1000);
  await budget.begin(300);
  expect(budget.remaining()).toBe(700);
  now = new Date("2026-11-18");
  expect(budget.remaining()).toBe(80000);
});
it("R2 local reservations exist only in flight and are never persisted", async () => {
  const day = "2026-11-17",
    usage = {
      day,
      used: 53000,
      reserved: 0,
      staleLeasesReleased: 0,
      limit: 80000,
      resetAt: "2026-11-18T00:00:00.000Z",
    };
  const persist = vi.fn(async () => {}),
    budget = new WriteBudget(
      { day, rows: 80000, reserved: 31318 },
      () => new Date(day),
      persist,
      true,
    );
  let send: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    send = resolve;
  });
  const api = apiClient(
    "https://local",
    "synthetic",
    vi.fn(async (url) => {
      if (String(url).endsWith("/budget"))
        return Response.json({ success: true, data: usage });
      await pending;
      throw new Error("connection reset");
    }) as typeof fetch,
    budget,
    async () => {},
  );
  await api.get("/budget");
  const write = api.write("/ingest/feed-day", {}, 10);
  await vi.waitFor(() => expect(budget.state.reserved).toBeGreaterThan(0));
  expect(persist).toHaveBeenCalledExactlyOnceWith(usage);
  send();
  await write;
  expect(budget.state.reserved).toBe(0);
  expect(persist).toHaveBeenCalledTimes(1);
});
it("R2 a failed read also releases its in-memory reservation", async () => {
  const budget = new WriteBudget(
    { day: "2026-11-17", rows: 0 },
    () => new Date("2026-11-17"),
    async () => {},
    true,
  );
  const api = apiClient(
    "https://local",
    "synthetic",
    vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch,
    budget,
    async () => {},
  );
  await expect(api.get("/feed/days")).rejects.toThrow("unreachable");
  expect(budget.state.reserved).toBe(0);
});

it("accepts an own server's higher write limit from the server", async () => {
  const day = "2026-11-23";
  const budget = new WriteBudget(
    { day, rows: 0 },
    () => new Date(day),
    async () => {},
  );
  await budget.synchronize({
    day,
    used: 100_000,
    reserved: 0,
    staleLeasesReleased: 0,
    limit: 1_000_000,
    baseLimit: 1_000_000,
    resetAt: "2026-11-24T00:00:00.000Z",
  });
  expect(budget.remaining()).toBe(900_000);
});
