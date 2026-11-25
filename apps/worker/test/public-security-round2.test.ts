import { afterEach, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
const display = {
  name: "PRIVATE_INSTANCE",
  language: "zh",
  timezone: "Asia/Shanghai",
  topics: ["PRIVATE_TOPIC"],
};
afterEach(() => vi.useRealTimers());
it("P1 hides all configured instance fields unless public or authenticated", async () => {
  const { env } = workerEnv();
  const privateEnv = { ...env, INSTANCE_CONFIG: JSON.stringify(display) };
  for (const PUBLIC_FEED of [undefined, "false", "TRUE"]) {
    const response = await app.request(
      "/api/v1/instance",
      {},
      { ...privateEnv, PUBLIC_FEED },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      data: { name: "LitScout" },
    });
  }
  const local = await app.request(
    "/api/v1/instance",
    {},
    { ...privateEnv, LOCAL_DEV: "true" },
  );
  expect(await local.json()).toMatchObject({
    data: { ...display, publicFeed: false },
  });
  const publicInfo = await app.request(
    "/api/v1/instance",
    {},
    { ...privateEnv, PUBLIC_FEED: "true" },
  );
  expect(await publicInfo.json()).toMatchObject({
    data: { ...display, publicFeed: true },
  });
  const invalid = await app.request(
    "/api/v1/instance",
    {
      headers: {
        authorization: "Bearer invalid",
        "Cf-Access-Jwt-Assertion": "invalid",
      },
    },
    privateEnv,
  );
  expect(await invalid.json()).toEqual({
    success: true,
    data: { name: "LitScout" },
  });
});
it("P2 shares 60 reads across public paths and HEAD per IP, ignores spoofed forwarding headers and resets", async () => {
  vi.useFakeTimers();
  const { env } = workerEnv();
  const options = { ...env, PUBLIC_FEED: "true" };
  const read = (
    ip: string,
    method = "GET",
    path = "/api/v1/public/days",
    forwarded = "192.0.2.99",
  ) =>
    app.request(
      path,
      {
        method,
        headers: { "CF-Connecting-IP": ip, "X-Forwarded-For": forwarded },
      },
      options,
    );
  for (let i = 0; i < 60; i++)
    expect(
      (
        await read(
          "192.0.2.42",
          i % 2 ? "HEAD" : "GET",
          i % 2 ? "/api/v1/public/days/2026-11-17" : "/api/v1/public/days",
        )
      ).status,
    ).not.toBe(429);
  const blocked = await read("192.0.2.42", "GET", undefined, "192.0.2.100");
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("retry-after")).toBe("60");
  expect(await blocked.json()).toEqual({
    success: false,
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  });
  expect((await read("192.0.2.43")).status).not.toBe(429);
  vi.advanceTimersByTime(60_000);
  expect((await read("192.0.2.42")).status).not.toBe(429);
});
