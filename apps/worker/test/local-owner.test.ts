import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { health } from "../src/health";
import { workerEnv } from "./helpers/worker-env";

// A trial on the reader's own computer: the server listens on the loopback
// interface, has no Cloudflare Access in front of it, and takes a request
// addressed to that computer as the owner's.
let close: () => Promise<void>;
let env: ReturnType<typeof workerEnv>["env"];
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  env = {
    ...workerEnv().env,
    DB: h.db.$client as unknown as D1Database,
    PUBLIC_URL: "http://127.0.0.1:8787",
    LITSCOUT_RUNTIME: "server",
    LOCAL_OWNER: "true",
  };
});
afterAll(() => close());
const days = (origin: string, with_ = env) =>
  app.request(`${origin}/api/v1/feed/days`, {}, with_);

it("takes a request to this computer as the owner's", async () => {
  for (const origin of ["http://127.0.0.1:8787", "http://localhost:8787"])
    expect((await days(origin)).status, origin).toBe(200);
  const instance = await app.request(
    "http://127.0.0.1:8787/api/v1/instance",
    {},
    env,
  );
  expect(await instance.json()).toMatchObject({
    data: { name: "LitScout", publicFeed: false },
  });
  expect(
    (await app.request("http://127.0.0.1:8787/app/days", {}, env)).status,
  ).toBe(200);
});

it("refuses any other host name, which a foreign page could point here", async () => {
  // DNS rebinding: a page's own name resolves to 127.0.0.1, so its requests
  // are same-origin for the browser and reach this server.
  for (const origin of [
    "http://rebind.example:8787",
    "http://127.0.0.1.example:8787",
    "http://192.168.1.20:8787",
  ]) {
    const response = await days(origin);
    expect(response.status, origin).toBe(401);
  }
  expect(
    (await app.request("http://rebind.example:8787/app/days", {}, env)).status,
  ).toBe(401);
});

it("refuses a request that came through a proxy or to another port", async () => {
  // The switch copied onto a real server: nginx and a tunnel can both hand
  // on "Host: 127.0.0.1:8787", which would make every visitor the owner.
  const added: [string, string][] = [
    ["X-Forwarded-For", "203.0.113.7"],
    ["X-Forwarded-Host", "reader.example.org"],
    ["X-Forwarded-Proto", "https"],
    ["Forwarded", "for=203.0.113.7"],
    ["X-Real-IP", "203.0.113.7"],
    ["Via", "1.1 proxy"],
    ["CF-Ray", "8f0-SIN"],
    ["CF-Connecting-IP", "203.0.113.7"],
    ["Cf-Access-Jwt-Assertion", "x.y.z"],
  ];
  for (const [name, value] of added) {
    const response = await app.request(
      "http://127.0.0.1:8787/api/v1/feed/days",
      { headers: { [name]: value } },
      env,
    );
    expect(response.status, name).toBe(401);
  }
  // Miniflare adds the address the connection came from: this computer's.
  for (const peer of ["127.0.0.1", "::1"])
    expect(
      (
        await app.request(
          "http://127.0.0.1:8787/api/v1/feed/days",
          { headers: { "CF-Connecting-IP": peer } },
          env,
        )
      ).status,
      peer,
    ).toBe(200);
  // Another program's port on this computer is not this server.
  expect((await days("http://127.0.0.1:9999")).status).toBe(401);
  expect((await days("http://localhost")).status).toBe(401);
});

it("refuses a write from another site and takes one from its own page", async () => {
  const write = (headers: Record<string, string>) =>
    app.request(
      "http://127.0.0.1:8787/api/v1/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      },
      env,
    );
  expect(
    (
      await write({
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://elsewhere.example",
      })
    ).status,
  ).toBe(403);
  // Past sign-in and the same-origin check: the empty event is what fails.
  expect(
    (
      await write({
        "Sec-Fetch-Site": "same-origin",
        Origin: "http://127.0.0.1:8787",
      })
    ).status,
  ).toBe(400);
});

it("does nothing on Cloudflare or without the switch", async () => {
  const cloudflare = { ...env, LITSCOUT_RUNTIME: undefined };
  expect((await days("http://127.0.0.1:8787", cloudflare)).status).not.toBe(
    200,
  );
  expect(
    (await days("http://127.0.0.1:8787", { ...env, LOCAL_OWNER: "false" }))
      .status,
  ).not.toBe(200);
});

it("still checks a token that is sent", async () => {
  const response = await app.request(
    "http://127.0.0.1:8787/api/v1/feed/days",
    { headers: { Authorization: "Bearer " + "x".repeat(40) } },
    env,
  );
  expect(response.status).toBe(401);
});

it("tells the CLI that it is a trial", async () => {
  // doctor words its sign-in check by this.
  expect((await health(env)).details).toMatchObject({
    runtime: "server",
    trial: true,
  });
  expect(
    (await health({ ...env, LOCAL_OWNER: undefined })).details,
  ).not.toHaveProperty("trial");
});
