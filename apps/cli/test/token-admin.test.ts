import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
type Handler = (url: string, init: RequestInit) => Response;
async function harness(handler: Handler) {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-token-admin-"));
  dirs.push(dir);
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ token: "mgmt-value", name: "sample" }),
    { mode: 0o600 },
  );
  const out: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  return {
    dir,
    out,
    requests,
    deps: {
      isTTY: true,
      dir,
      cwd: dir,
      nodeVersion: "22.13.0",
      bundlePath: path.resolve("packages/db/worker.js"),
      templateDir: path.resolve("templates/self-host"),
      run: vi.fn(async (_args: readonly string[]) => "[]"),
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init: init ?? {} });
        return handler(url, init ?? {});
      }),
      fetchVenues: vi.fn(),
      prompt: vi.fn(),
      print: (s: string) => out.push(s),
      loadConfig: async () =>
        defineConfig({
          instance: { name: "sample", publicUrl: "https://own.example" },
        }),
    },
  };
}

it("creates a token through the instance's admin route, sending only its hash", async () => {
  const h = await harness(() =>
    Response.json({ created: "x" }, { status: 201 }),
  );
  expect(
    await runCommand(
      [
        "token",
        "create",
        "--name",
        "server",
        "--scopes",
        "read,ingest",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  const token = JSON.parse(h.out[0]!).data.token as string;
  expect(h.deps.run).not.toHaveBeenCalled();
  const [request] = h.requests;
  expect(request!.url).toBe("https://own.example/admin/tokens");
  expect(request!.init.method).toBe("POST");
  expect(new Headers(request!.init.headers).get("authorization")).toBe(
    "Bearer mgmt-value",
  );
  const body = JSON.parse(String(request!.init.body));
  expect(body).toMatchObject({ name: "server", scopes: ["read", "ingest"] });
  expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(String(request!.init.body)).not.toContain(token);
  const saved = JSON.parse(
    await readFile(path.join(h.dir, "credentials.json"), "utf8"),
  );
  expect(saved.tokens[0]).toMatchObject({ url: "https://own.example" });
});

it("lists and revokes through the admin routes", async () => {
  const h = await harness((url) =>
    url.endsWith("/revoke")
      ? Response.json({ revoked: [] })
      : Response.json({ tokens: [{ id: "tok_01ARZ3NDEKTSV4RRFFQ69G5FAV" }] }),
  );
  expect(await runCommand(["token", "list", "--json"], h.deps)).toBe(0);
  expect(
    await runCommand(
      ["token", "revoke", "tok_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      h.deps,
    ),
  ).toBe(2);
  expect(h.requests.map((r) => r.url)).toEqual([
    "https://own.example/admin/tokens",
    "https://own.example/admin/tokens/revoke",
  ]);
  expect(h.deps.run).not.toHaveBeenCalled();
});

it("falls back to Wrangler for a Worker without the token routes, and removes the credential on a refused insert", async () => {
  const old = await harness(() => new Response("Not found", { status: 404 }));
  expect(await runCommand(["token", "list", "--json"], old.deps)).toBe(2);
  expect(old.deps.run).toHaveBeenCalledTimes(1);

  const refused = await harness(() =>
    Response.json({ error: "Token already exists" }, { status: 409 }),
  );
  expect(
    await runCommand(
      ["token", "create", "--name", "dup", "--scopes", "read", "--json"],
      refused.deps,
    ),
  ).toBe(1);
  const saved = await readFile(
    path.join(refused.dir, "credentials.json"),
    "utf8",
  ).catch(() => '{"tokens":[]}');
  expect(JSON.parse(saved).tokens).toEqual([]);
  expect(refused.deps.run).not.toHaveBeenCalled();
});
