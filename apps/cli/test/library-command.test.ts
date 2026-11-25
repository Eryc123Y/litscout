import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";
import { checkLink } from "../src/link-check";

function harness() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("instance.example");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture",
    );
    const data = url.pathname.endsWith("/save")
      ? {
          status: "confirm",
          candidates: [{ title: "Vision", query: "10.1000/example" }],
        }
      : url.pathname.endsWith("/links") && init?.method === "GET"
        ? {
            items: [
              { id: "lnk_fixture", url: "https://doi.org/10.1000/example" },
            ],
          }
        : url.pathname.endsWith("/links")
          ? { updated: 1 }
          : {
              items: [{ paperId: "pap_one", title: "Vision" }],
              nextCursor: null,
            };
    return Response.json({ success: true, data });
  });
  const print = vi.fn();
  const probeLink = vi.fn(async () => 206);
  const deps = {
    fetch,
    cwd: process.cwd(),
    print,
    loadConfig: async () =>
      defineConfig({ instance: { publicUrl: "https://instance.example" } }),
    flow: {
      token: "fixture",
      now: () => new Date("2026-11-18T12:00:00.000Z"),
      probeLink,
    },
  } as unknown as SetupDeps;
  return { fetch, print, probeLink, deps };
}

it("supports CLI save (including confirmation) and title/author search", async () => {
  const { fetch, print, deps } = harness();
  expect(
    await runCommand(
      ["save", "A", "Vision", "Paper", "--dry-run", "--json"],
      deps,
    ),
  ).toBe(0);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
    query: "A Vision Paper",
    dry_run: true,
    source: "cli",
  });
  expect(JSON.parse(print.mock.calls[0]![0]).data.candidates[0].query).toBe(
    "10.1000/example",
  );
  expect(await runCommand(["search", "Ada", "Smith"], deps)).toBe(0);
  expect(String(fetch.mock.calls[1]![0])).toContain("q=Ada+Smith");
  expect(await runCommand(["search", "ab"], deps)).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("fetches one ingest slice and posts observations without changing link URLs", async () => {
  const { deps, fetch, probeLink } = harness();
  expect(await runCommand(["links", "check", "--limit", "1"], deps)).toBe(0);
  expect(String(fetch.mock.calls[0]![0])).toContain("/ingest/links?limit=1");
  expect(probeLink).toHaveBeenCalledWith("https://doi.org/10.1000/example");
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
    checks: [
      {
        id: "lnk_fixture",
        url: "https://doi.org/10.1000/example",
        httpStatus: 206,
        checkedAt: "2026-11-18T12:00:00.000Z",
      },
    ],
  });
});

it("uses HEAD before a bounded GET, follows public redirects and rejects local targets", async () => {
  const probe = vi.fn(async (url: URL, method: string) =>
    url.hostname === "doi.org"
      ? { status: 302, location: "https://publisher.example/article" }
      : { status: method === "HEAD" ? 405 : 206 },
  );
  expect(await checkLink("https://doi.org/10.1000/example", probe)).toBe(206);
  expect(
    probe.mock.calls.map(([url, method]) => [url.hostname, method]),
  ).toEqual([
    ["doi.org", "HEAD"],
    ["publisher.example", "HEAD"],
    ["publisher.example", "GET"],
  ]);
  probe.mockClear();
  expect(await checkLink("http://127.0.0.1/private", probe)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it("continues Library searches across an empty first page", async () => {
  const { deps, fetch, print } = harness();
  fetch.mockResolvedValueOnce(
    Response.json({
      success: true,
      data: { items: [], nextCursor: "next-page" },
    }),
  );
  expect(await runCommand(["search", "Vision", "--json"], deps)).toBe(0);
  expect(String(fetch.mock.calls[1]![0])).toContain("cursor=next-page");
  expect(JSON.parse(print.mock.calls[0]![0]).data.items).toMatchObject([
    { title: "Vision" },
  ]);
});
