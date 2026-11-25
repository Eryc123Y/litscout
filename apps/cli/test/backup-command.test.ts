import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { backupDataSections } from "@litscout/pipeline/backup-contracts";
import { runCommand, type SetupDeps } from "../src/setup-commands";

it("writes a private gzip export, verifies it offline, and rejects invalid bundles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-backup-test-"));
  try {
    const prints: string[] = [];
    let cooldown = false;
    const expectedCounts = {
      ...Object.fromEntries(backupDataSections.map((section) => [section, 0])),
      library: 2,
      papers: 1,
      paperIdentifiers: 1,
      configuredTopics: 1,
    };
    const requests = vi.fn(async (url: URL) => {
      if (cooldown)
        return Response.json(
          { success: false, error: { code: "BACKUP_COOLDOWN" } },
          { status: 429, headers: { "Retry-After": "437" } },
        );
      const name = url.pathname.split("/").at(-1);
      const data =
        name === "backup"
          ? {
              expectedCounts,
              instanceName: "My research",
              configuredTopics: [{ name: "Depth", keywords: [] }],
            }
          : name === "library"
            ? {
                items: [
                  {
                    paper_id: "pap_a",
                    status: "saved",
                    tags: ["vision"],
                    added_via: "cli",
                    added_at: "2026-11-19",
                    updated_at: "2026-11-19",
                    rev: 1,
                  },
                ],
                nextCursor: null,
              }
            : name === "papers"
              ? [
                  {
                    id: "pap_a",
                    paper: {
                      id: "pap_a",
                      title: "Paper",
                      abstract: null,
                      tldr: "",
                      authors: [],
                      venue: null,
                      venue_kind: null,
                      year: null,
                      published_on: null,
                      primary_category: null,
                      categories: [],
                      first_seen_on: null,
                      source: "manual",
                      verified: 1,
                      created_at: "2026-11-19",
                      updated_at: "2026-11-19",
                      rev: 1,
                    },
                    identifiers: [
                      {
                        paper_id: "pap_a",
                        scheme: "doi",
                        value: "10.1000/unit",
                      },
                    ],
                    links: [],
                    identifiersAfter: null,
                    linksAfter: null,
                  },
                ]
              : { items: [], nextCursor: null };
      return Response.json({ success: true, data });
    });
    const loadConfig = vi.fn(async () =>
      defineConfig({ instance: { publicUrl: "https://local.invalid" } }),
    );
    const deps = {
      cwd: dir,
      dir,
      flow: {
        token: "lsk_" + "R".repeat(52),
        now: () => new Date("2026-11-19T00:00:00.000Z"),
      },
      fetch: requests,
      loadConfig,
      print: (line: string) => prints.push(line),
    } as unknown as SetupDeps;
    expect(
      await runCommand(["backup", "--out", "unit.json.gz", "--json"], deps),
    ).toBe(0);
    const file = path.join(dir, "unit.json.gz");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const bundle = JSON.parse(
      gunzipSync(await readFile(file)).toString("utf8"),
    );
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      instanceName: "My research",
      createdAt: "2026-11-19T00:00:00.000Z",
      expectedCounts,
    });
    expect(bundle.configuredTopics).toEqual([{ name: "Depth", keywords: [] }]);
    requests.mockClear();
    loadConfig.mockClear();
    expect(await runCommand(["backup", "--verify", file, "--json"], deps)).toBe(
      0,
    );
    expect(JSON.parse(prints.at(-1)!).data.counts).toMatchObject({
      library: 1,
      paperIdentifiers: 1,
      weeklyDigests: 0,
      configuredTopics: 1,
    });
    expect(JSON.parse(prints.at(-1)!).data).toMatchObject({
      verified: true,
      expectedCounts,
      warnings: [
        expect.stringMatching(/library.*changed during export.*2.*1/i),
      ],
    });
    expect(await runCommand(["backup", "--verify", file], deps)).toBe(0);
    expect(prints.at(-1)).toContain("changed during export");
    expect(loadConfig).not.toHaveBeenCalled();
    expect(requests).not.toHaveBeenCalled();

    for (const invalid of [
      { ...bundle, schemaVersion: 2 },
      {
        ...bundle,
        data: {
          ...bundle.data,
          paperState: [{ paper_id: "pap_missing_fields" }],
        },
      },
      { ...bundle, api_tokens: [] },
    ]) {
      await writeFile(file, gzipSync(JSON.stringify(invalid)));
      expect(
        await runCommand(["backup", "--verify", file, "--json"], deps),
      ).toBe(1);
    }
    expect(bundle.counts.library).toBe(1);
    const sha256 = (data: unknown) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(data as Record<string, object[]>).map(
                ([section, rows]) => [
                  section,
                  rows.map((row) =>
                    Object.fromEntries(
                      Object.entries(row).sort(([a], [b]) =>
                        a < b ? -1 : a > b ? 1 : 0,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        )
        .digest("hex");
    expect(bundle.sha256).toBe(sha256(bundle.data));
    const [row] = bundle.data.library;
    const replaceLibrary = (library: (typeof row)[]) => {
      const data = { ...bundle.data, library };
      return {
        ...bundle,
        data,
        counts: { ...bundle.counts, library: library.length },
        sha256: sha256(data),
      };
    };
    for (const [invalid, message] of [
      [{ ...bundle, data: { ...bundle.data, library: [] } }, /count.*library/i],
      [{ ...bundle, sha256: "0".repeat(64) }, /SHA-256/i],
      [replaceLibrary([row, row]), /duplicate.*library/i],
      [
        replaceLibrary([{ ...row, paper_id: "pap_unknown" }]),
        /library.*pap_unknown/i,
      ],
    ] as const) {
      await writeFile(file, gzipSync(JSON.stringify(invalid)));
      expect(
        await runCommand(["backup", "--verify", file, "--json"], deps),
      ).toBe(1);
      expect(JSON.parse(prints.at(-1)!).data.message).toMatch(message);
    }
    cooldown = true;
    expect(
      await runCommand(["backup", "--out", "cooldown.json.gz", "--json"], deps),
    ).toBe(1);
    expect(JSON.parse(prints.at(-1)!).data.message).toContain("437 seconds");
    cooldown = false;
    await writeFile(file, "former export");
    expect(await runCommand(["backup", "--out", file, "--json"], deps)).toBe(1);
    expect(await readFile(file, "utf8")).toBe("former export");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
