import { expect, it } from "vitest";
import { z } from "zod";
import {
  ideasPage,
  vaultMatchResult,
  vaultPaperNote,
  vaultStatus,
} from "@litscout/pipeline/vault-contracts";
import {
  suggestionsPage,
  workingPaperDetail,
  workingPapersPage,
} from "@litscout/pipeline/research-contracts";
import { webRuntime } from "./helpers/web-runtime";

it("serves the private browser fixtures through the real local Worker", async () => {
  const runtime = await webRuntime({ researchFixtures: true });
  try {
    const get = async <T>(url: string, shape: z.ZodType<T>) => {
      const response = await runtime.dispatchFetch(
        "http://127.0.0.1:4173/api/v1" + url,
      );
      expect(response.status, url).toBe(200);
      return z.object({ data: shape }).parse(await response.json()).data;
    };
    const ideas = await get("/ideas", ideasPage);
    expect(ideas.items).toMatchObject([
      { title: "PRIVATE_Depth idea", status: "seed" },
    ]);
    const drafts = await get("/working-papers", workingPapersPage);
    expect(drafts.items).toMatchObject([{ title: "PRIVATE_Depth draft" }]);
    const draft = await get(
      "/working-papers/" + drafts.items[0]!.id,
      workingPaperDetail,
    );
    expect(draft.reading).toMatchObject([{ status: "reading" }]);
    expect(draft.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringContaining("Anti-Aliasing Token Merging"),
        }),
      ]),
    );

    const suggestions = await get(
      "/suggestions?day=2026-11-17",
      suggestionsPage,
    );
    expect(suggestions.items).toHaveLength(4);
    const paperId = suggestions.items[0]!.paperIds[0]!;
    const title =
      "Beyond the Black Patch: A Composable, Gaze-Contingent Framework for Simulating Central Vision Loss in XR";
    const id = "f".repeat(64);
    const params = new URLSearchParams({ note: JSON.stringify({ id, title }) });
    expect(
      await get("/vault/matches?" + params, z.array(vaultMatchResult)),
    ).toEqual([{ id, paperId, matchedBy: "title" }]);
    expect(
      await get("/vault/paper-note/" + paperId, vaultPaperNote),
    ).toMatchObject({
      path: "PRIVATE_Vault/Black Patch.md",
      matchedBy: "title",
    });
    const sync = await get("/vault/status", vaultStatus);
    expect(sync.last?.writeEnabled).toBe(false);
    expect(sync.queued).toHaveLength(2);
    expect(sync.rejected).toMatchObject([
      { reason: "The idea note changed since it was indexed." },
    ]);
  } finally {
    await runtime.dispose();
  }
});
