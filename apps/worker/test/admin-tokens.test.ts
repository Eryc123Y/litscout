import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { securityWorker } from "./helpers/security-worker";

const mgmt = "m".repeat(40);
let local: Awaited<ReturnType<typeof securityWorker>>;
beforeAll(async () => {
  local = await securityWorker({
    bindings: { MGMT_TOKEN: mgmt, PUBLIC_URL: "https://local" },
  });
});
afterAll(async () => {
  await local.worker.dispose();
});

const admin = (path: string, method = "GET", body?: unknown, token = mgmt) =>
  local.endpoint.fetch("https://local/admin/" + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const token = "lsk_" + "T".repeat(52);
const record = {
  id: "tok_01JAAAAAAAAAAAAAAAAAAAAAAA",
  name: "server scheduler",
  hash: createHash("sha256").update(token).digest("hex"),
  scopes: ["read", "ingest"],
  expiresAt: null,
};

it("creates a token from its hash; the new token reads the API and the hash is never listed", async () => {
  expect((await admin("tokens", "POST", record)).status).toBe(201);
  const read = await local.endpoint.fetch("https://local/api/v1/feed/days", {
    headers: { authorization: "Bearer " + token },
  });
  expect(read.status).toBe(200);
  const listed = (await (await admin("tokens")).json()) as {
    tokens: Record<string, unknown>[];
  };
  const row = listed.tokens.find((t) => t.id === record.id);
  expect(row).toMatchObject({ name: "server scheduler" });
  expect(JSON.stringify(listed)).not.toContain(record.hash);
  expect((await admin("tokens", "POST", record)).status).toBe(409);
});

it("revokes a token once; the revoked token is refused", async () => {
  const first = await admin("tokens/revoke", "POST", { id: record.id });
  expect(await first.json()).toEqual({ revoked: [{ id: record.id }] });
  const again = await admin("tokens/revoke", "POST", { id: record.id });
  expect(await again.json()).toEqual({ revoked: [] });
  const read = await local.endpoint.fetch("https://local/api/v1/feed/days", {
    headers: { authorization: "Bearer " + token },
  });
  expect(read.status).toBe(401);
});

it("rejects bad records, past expiry, wrong methods and callers without the management token", async () => {
  expect((await admin("tokens", "POST", { ...record, hash: "x" })).status).toBe(
    400,
  );
  expect(
    (
      await admin("tokens", "POST", {
        ...record,
        id: "tok_01JBBBBBBBBBBBBBBBBBBBBBBB",
        hash: "a".repeat(64),
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    ).status,
  ).toBe(400);
  expect(
    (await admin("tokens", "POST", { ...record, extra: true })).status,
  ).toBe(400);
  expect((await admin("tokens/revoke", "POST", { id: "nope" })).status).toBe(
    400,
  );
  expect((await admin("tokens", "DELETE")).status).toBe(405);
  expect((await admin("tokens", "GET", undefined, "wrong")).status).toBe(401);
  expect(
    (await admin("tokens", "GET", undefined, local.tokens.admin)).status,
  ).toBe(401);
});
