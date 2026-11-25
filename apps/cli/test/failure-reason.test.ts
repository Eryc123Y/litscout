import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";

// A scheduled job only keeps the command's output. When the server cannot be
// read, that output has to name the cause (2026-11-22: two vault syncs failed
// with nothing but "check authentication and local configuration").
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-failure-reason-"));
  await mkdir(path.join(dir, "vault"));
  await writeFile(
    path.join(dir, "vault", "Idea.md"),
    "---\ntags: [type/idea]\n---\nAn idea\n",
  );
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const budget = {
  day: "2026-11-22",
  used: 100,
  reserved: 0,
  staleLeasesReleased: 0,
  limit: 80000,
  resetAt: "2026-11-23T00:00:00.000Z",
};
async function sync(
  budgetReply: () => Response,
  flow: Record<string, unknown> = { token: "synthetic" },
) {
  const out: string[] = [];
  const sent: string[] = [];
  const deps = {
    dir: path.join(dir, "state"),
    cwd: dir,
    env: {},
    isTTY: false,
    templateDir: dir,
    bundlePath: "unused",
    flow: { ...flow, sleep: async () => {} },
    fetch: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(url)).pathname;
      if (route === "/api/v1/budget") return budgetReply();
      if (init?.method === "GET")
        return Response.json({
          success: true,
          data: route.endsWith("/vault/index")
            ? { snapshot: null, count: 0 }
            : route.endsWith("/vault/requests")
              ? []
              : null,
        });
      sent.push(`${init?.method} ${route}`);
      return Response.json({
        success: true,
        data: { accepted: true, published: true, recorded: true },
        meta: { rowsWritten: 1 },
      });
    }),
    run: vi.fn(),
    fetchVenues: vi.fn(),
    prompt: vi.fn(),
    print: (line: string) => out.push(line),
    loadConfig: async () =>
      defineConfig({
        instance: { publicUrl: "https://local" },
        // With vault writes on, sync takes the server's budget as the
        // authority and reads it before the first write.
        vault: {
          root: path.join(dir, "vault"),
          write: true,
          digestsDir: "Digests",
        },
      }),
  } as unknown as SetupDeps;
  const code = await runCommand(["sync", "--json"], deps);
  return { code, sent, reply: JSON.parse(out.at(-1)!) };
}

it("sync names a budget reply from a server on another version", async () => {
  const { code, sent, reply } = await sync(() =>
    Response.json({
      success: true,
      data: { ...budget, limit: 20_000_000, baseLimit: 20_000_000 },
    }),
  );
  expect(code).toBe(1);
  expect(reply.success).toBe(false);
  expect(reply.data.message).toContain("does not fit this CLI");
  expect(reply.data.message).toContain("limit: ");
  expect(reply.data.message).toContain("update and rebuild the CLI");
  expect(reply.data.message).not.toContain("check authentication");
  expect(sent).toEqual([]);
});

it("sync names the HTTP status of a refused budget read", async () => {
  const { code, reply } = await sync(
    () => new Response("private upstream body", { status: 401 }),
  );
  expect(code).toBe(1);
  expect(reply.data.message).toContain("LitScout API HTTP 401");
  expect(reply.data.message).not.toContain("private upstream body");
});

it("sync says when the local token has expired", async () => {
  await mkdir(path.join(dir, "state"));
  await writeFile(
    path.join(dir, "state", "credentials.json"),
    JSON.stringify({
      tokens: [
        {
          token: "synthetic",
          url: "https://local",
          expiresAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const { code, sent, reply } = await sync(() => Response.json({}), {
    now: () => new Date("2026-11-22T13:20:00Z"),
  });
  expect(code).toBe(1);
  expect(reply.data.message).toBe(
    "No valid local token for this instance; create a token with read and ingest scopes",
  );
  expect(sent).toEqual([]);
});

it("an error this code did not write still shows no upstream text", async () => {
  const out: string[] = [];
  const deps = {
    dir: path.join(dir, "state"),
    cwd: dir,
    env: {},
    isTTY: false,
    templateDir: dir,
    bundlePath: "unused",
    flow: { token: "synthetic", sleep: async () => {} },
    fetch: vi.fn(),
    run: vi.fn(),
    fetchVenues: vi.fn(),
    prompt: vi.fn(),
    print: (line: string) => out.push(line),
    loadConfig: async () => {
      throw Object.assign(new Error("private upstream diagnostic"), {
        code: "ECONNRESET",
      });
    },
  } as unknown as SetupDeps;
  expect(await runCommand(["sync", "--json"], deps)).toBe(1);
  const { message } = JSON.parse(out.at(-1)!).data;
  expect(message).toBe(
    "Command failed (error code ECONNRESET); check authentication and local configuration",
  );
});
