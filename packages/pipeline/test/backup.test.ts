import { expect, it } from "vitest";
import { collectBackup } from "../src/backup";
import { backupDataSections } from "../src/backup-contracts";

const manifest = {
  instanceName: "Test",
  configuredTopics: [],
  expectedCounts: Object.fromEntries(
    [...backupDataSections, "configuredTopics"].map((section) => [section, 0]),
  ),
};

it("rejects a section cursor moving backward even if it has not appeared before", async () => {
  let pages = 0;
  await expect(
    collectBackup(async (path, schema) =>
      schema.parse(
        path === "/backup"
          ? manifest
          : { items: [], nextCursor: JSON.stringify([String(3 - ++pages)]) },
      ),
    ),
  ).rejects.toThrow(/cursor.*library.*did not advance/i);
  expect(pages).toBe(2);
});

it("rejects paper child cursors that do not advance", async () => {
  let paperRequests = 0;
  await expect(
    collectBackup(async (path, schema) =>
      schema.parse(
        path === "/backup"
          ? manifest
          : path === "/backup/library"
            ? {
                items: [
                  {
                    paper_id: "pap_test",
                    status: "saved",
                    tags: [],
                    added_via: "cli",
                    added_at: "2026-11-19",
                    updated_at: "2026-11-19",
                    rev: 1,
                  },
                ],
                nextCursor: null,
              }
            : path === "/backup/papers"
              ? [
                  {
                    id: "pap_test",
                    paper: null,
                    identifiers: [],
                    links: [],
                    identifiersAfter: ["doi", String(3 - ++paperRequests)],
                    linksAfter: null,
                  },
                ]
              : { items: [], nextCursor: null },
      ),
    ),
  ).rejects.toThrow(/paper.*cursor.*did not advance/i);
  expect(paperRequests).toBe(2);
});
