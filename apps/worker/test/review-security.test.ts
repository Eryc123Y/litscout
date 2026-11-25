import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { authHandler } from "../src/auth/handler";
import { normaliseUrl } from "../src/request-path";
import { workerEnv } from "./helpers/worker-env";
import { PairingStore } from "../src/auth/pairing-store";
import { memoryState } from "@litscout/core/test/helpers/storage";
import type { AppEnv } from "../src/env";
afterEach(() => vi.restoreAllMocks());
const unavailable = {
  success: false,
  error: { code: "UNAVAILABLE", message: "Service unavailable" },
};
it.each(["/app/../x", "/app/%2e%2e/x", "/%2Fapp/x", "/app%5cx", "/%zz"])(
  "rejects unsafe raw paths before parsing: %s",
  (path) => {
    expect(() => normaliseUrl("https://worker.example" + path)).toThrow();
  },
);
it("collapses slashes before authentication and only serves allowlisted assets", async () => {
  const { env, ctx } = workerEnv();
  const assets = vi.fn(async () => new Response("asset"));
  const bound = { ...env, ASSETS: { fetch: assets } as unknown as Fetcher };
  const call = (path: string) =>
    worker.fetch(
      new Request("https://worker.example" + path) as never,
      bound,
      ctx,
    );
  expect((await call("//app/x")).status).toBe(503);
  expect(assets).not.toHaveBeenCalled();
  expect(await (await call("//app/x")).json()).toEqual(unavailable);
  for (const path of [
    "/",
    "/assets/main.js",
    "/favicon.ico",
    "/robots.txt",
    "/public/example.json",
  ]) {
    expect((await call(path)).status).toBe(200);
  }
  const count = assets.mock.calls.length;
  for (const path of ["/unknown", "/hidden.html"]) {
    expect((await call(path)).status).toBe(404);
  }
  expect((await call("/%61pp/x")).status).toBe(503);
  expect(assets).toHaveBeenCalledTimes(count);
  expect((await call("/%2Fapp/x")).status).toBe(400);
  const raw = new Request("https://worker.example/x");
  Object.defineProperty(raw, "url", {
    value: "https://worker.example/app/../x",
  });
  expect((await worker.fetch(raw as never, bound, ctx)).status).toBe(400);
  expect(
    (
      await worker.fetch(
        new Request("https://worker.example//app/x") as never,
        { ...bound, LOCAL_DEV: "true" },
        ctx,
      )
    ).status,
  ).toBe(200);
});
it("only exposes a boolean health result and generic configuration errors", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { env, ctx } = workerEnv();
  const call = (path: string) =>
    worker.fetch(
      new Request("https://worker.example" + path) as never,
      env,
      ctx,
    );
  expect(await (await call("/health")).json()).toEqual({ ok: false });
  expect((await call("/api/v1/health")).status).toBe(401);
  const noMgmt = { ...env, MGMT_TOKEN: undefined };
  expect(
    await (
      await worker.fetch(
        new Request("https://worker.example/admin/clients") as never,
        noMgmt,
        ctx,
      )
    ).json(),
  ).toEqual(unavailable);
  expect(
    await (
      await worker.fetch(
        new Request("https://worker.example/authorize") as never,
        { ...env, CONSENT_SECRET: undefined },
        ctx,
      )
    ).json(),
  ).toEqual(unavailable);
  expect(log.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: "error",
        context: { reason: "Admin requires MGMT_TOKEN" },
      }),
    ]),
  );
});
it("one exhausted consent cannot invalidate the owner's pairing code", async () => {
  const state = memoryState().state;
  const store = new PairingStore(state, {} as AppEnv);
  const { code } = await store.create();
  for (let i = 0; i < 5; i++)
    expect(
      await store.consume("wrong", "shared-client", "attacker-handle"),
    ).toBeNull();
  const recreated = new PairingStore(state, {} as AppEnv);
  expect(
    await recreated.consume(code, "shared-client", "attacker-handle"),
  ).toBeNull();
  expect(
    await recreated.consume(code, "shared-client", "owner-handle"),
  ).not.toBeNull();
});
it("limits authorize POSTs per IP and restores a bucket after a minute", async () => {
  vi.useFakeTimers();
  const { env, ctx } = workerEnv();
  const call = (ip: string) =>
    worker.fetch(
      new Request("https://worker.example/authorize", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: new URLSearchParams(),
      }) as never,
      env,
      ctx,
    );
  for (let i = 0; i < 10; i++)
    expect((await call("192.0.2.1")).status).not.toBe(429);
  const denied = await call("192.0.2.1");
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("60");
  expect((await call("192.0.2.2")).status).not.toBe(429);
  vi.advanceTimersByTime(60_000);
  expect((await call("192.0.2.1")).status).not.toBe(429);
});
it("limits unauthenticated admin requests before credential verification", async () => {
  const { env, ctx } = workerEnv();
  const call = (ip: string) =>
    worker.fetch(
      new Request("https://worker.example/admin/clients", {
        headers: { "CF-Connecting-IP": ip },
      }) as never,
      env,
      ctx,
    );
  for (let i = 0; i < 30; i++)
    expect((await call("192.0.2.3")).status).toBe(401);
  expect((await call("192.0.2.3")).status).toBe(429);
  expect((await call("192.0.2.4")).status).toBe(401);
});

it("threads each consent handle through authorize so another client's failures do not lock the owner", async () => {
  const { env, store, ctx } = workerEnv();
  const { code } = await store.create();
  const oauth = {
    approveConsent: vi.fn(async () => ({
      request: { clientId: "shared-client", scope: [] },
      headers: new Headers(),
    })),
    lookupClient: vi.fn(async () => ({ clientName: "Test client" })),
    completeAuthorization: vi.fn(async () => ({
      redirectTo: "https://client.example/callback",
    })),
  };
  const bound = {
    ...env,
    OAUTH_PROVIDER: oauth as unknown as NonNullable<AppEnv["OAUTH_PROVIDER"]>,
  };
  const submit = (handle: string, value: string) =>
    authHandler.fetch(
      new Request("https://worker.example/authorize", {
        method: "POST",
        body: new URLSearchParams({ handle, decision: "approve", code: value }),
      }),
      bound,
      ctx,
    );
  for (let i = 0; i < 5; i++)
    expect((await submit("attacker-consent", "wrong")).status).toBe(403);
  expect((await submit("owner-consent", code)).status).toBe(302);
  expect(oauth.completeAuthorization).toHaveBeenCalledTimes(1);
});
