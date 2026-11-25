import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { writeBudgetUsage } from "@litscout/db/write-budget";
import worker from "../src/index";
import { workerEnv } from "./helpers/worker-env";

const validToken = "lsk_" + "A".repeat(52);
const invalidToken = "lsk_" + "B".repeat(52);

function mcp(token: string, ip = "192.0.2.1", forwarded = ip) {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "CF-Connecting-IP": ip,
      "X-Forwarded-For": forwarded,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }) as Parameters<typeof worker.fetch>[0];
}

it("records MCP token use through waitUntil and charges the write budget once per minute", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const client = db.$client as D1Database;
    const { env: base, ctx } = workerEnv();
    const env = { ...base, DB: client };
    const pending: Promise<unknown>[] = [];
    ctx.waitUntil = (task) => {
      pending.push(task);
    };
    // D1 keeps its wall clock. Start at the current UTC hour so leases are
    // still refundable and the simulated requests stay on one ledger day.
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);
    vi.setSystemTime(now);
    await client
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_mcp','MCP token',?,'[\"read\"]')",
      )
      .bind(createHash("sha256").update(validToken).digest("hex"))
      .run();
    const lastUsed = () =>
      client
        .prepare(
          "SELECT last_used_at AS lastUsedAt FROM api_tokens WHERE id='tok_mcp'",
        )
        .first("lastUsedAt");
    const day = now.toISOString().slice(0, 10);
    const usage = () => writeBudgetUsage(client, day);

    expect((await worker.fetch(mcp(validToken), env, ctx)).status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await lastUsed()).toBe(now.toISOString());
    expect(await usage()).toMatchObject({ used: 6, reserved: 0 });

    vi.setSystemTime(now.getTime() + 59_999);
    expect((await worker.fetch(mcp(validToken), env, ctx)).status).toBe(200);
    expect(pending).toHaveLength(1);
    expect(await lastUsed()).toBe(now.toISOString());
    expect(await usage()).toMatchObject({ used: 6, reserved: 0 });

    const nextUse = new Date(now.getTime() + 60_000);
    vi.setSystemTime(nextUse);
    expect((await worker.fetch(mcp(validToken), env, ctx)).status).toBe(200);
    expect(pending).toHaveLength(2);
    await Promise.all(pending);
    expect(await lastUsed()).toBe(nextUse.toISOString());
    expect(await usage()).toMatchObject({ used: 11, reserved: 0 });

    await client
      .prepare("UPDATE daily_write_usage SET rows_written=80000 WHERE day=?")
      .bind(day)
      .run();
    vi.setSystemTime(nextUse.getTime() + 60_000);
    expect((await worker.fetch(mcp(validToken), env, ctx)).status).toBe(200);
    await Promise.all(pending);
    expect(await lastUsed()).toBe(nextUse.toISOString());
    expect(await usage()).toMatchObject({ used: 80000, reserved: 0 });
  } finally {
    await close();
  }
});

it("rate-limits invalid MCP bearer lookups by connecting IP before reading D1", async () => {
  const { db, close } = await databaseHarness("d1");
  try {
    const client = db.$client as D1Database;
    const { env: base, ctx } = workerEnv();
    const prepare = vi.fn((sql: string) => client.prepare(sql));
    const env = { ...base, DB: { prepare } as unknown as D1Database };
    vi.setSystemTime(new Date("2026-11-18T01:00:00.000Z"));
    for (let i = 0; i < 120; i++) {
      const response = await worker.fetch(mcp(invalidToken), env, ctx);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer error="invalid_token"',
      );
    }
    expect(prepare).toHaveBeenCalledTimes(120);
    for (let i = 1; i <= 3; i++) {
      const response = await worker.fetch(
        mcp(invalidToken, "192.0.2.1", `198.51.100.${i}`),
        env,
        ctx,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(prepare).toHaveBeenCalledTimes(120);
    expect(
      (await worker.fetch(mcp(invalidToken, "192.0.2.2"), env, ctx)).status,
    ).toBe(401);
    expect(prepare).toHaveBeenCalledTimes(121);
    vi.setSystemTime(new Date("2026-11-18T01:01:00.000Z"));
    expect((await worker.fetch(mcp(invalidToken), env, ctx)).status).toBe(401);
    expect(prepare).toHaveBeenCalledTimes(122);
  } finally {
    await close();
  }
});
