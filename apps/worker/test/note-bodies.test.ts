import { expect, it } from "vitest";
import { z } from "zod";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

// The web reads an uploaded project, idea or draft body by note ID. Paper
// notes, removed notes and unknown IDs read as null, and the route is
// private: the public API has no counterpart.
const project = "d".repeat(64);
const paperNote = "e".repeat(64);
const removed = "f".repeat(64);
const day = "2026-11-20";

it("serves an uploaded note body read-only and nothing else", async () => {
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as unknown as D1Database;
  try {
    for (const [id, kind, body, deletedAt] of [
      [project, "project", "# Plan\n\nRead first.", null],
      [paperNote, "paper_note", "Paper body", null],
      [removed, "idea", "Gone", day],
    ] as const)
      await client
        .prepare(
          "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at,body_md,deleted_at) VALUES (?,?,?,?,'{}',?,?,?,?,?,?)",
        )
        .bind(
          id,
          "Notes/" + id + ".md",
          kind,
          "Note " + kind,
          id,
          id,
          id,
          day,
          body,
          deletedAt,
        )
        .run();
    const env = { ...workerEnv().env, DB: client, LOCAL_DEV: "true" };
    const get = (route: string) => app.request("/api/v1" + route, {}, env);

    const response = await get("/vault/notes/" + project);
    expect(response.status).toBe(200);
    expect(
      z.object({ data: z.unknown() }).parse(await response.json()).data,
    ).toEqual({
      id: project,
      kind: "project",
      title: "Note project",
      path: "Notes/" + project + ".md",
      bodyMd: "# Plan\n\nRead first.",
    });
    for (const id of [paperNote, removed, "a".repeat(64)]) {
      const missing = await get("/vault/notes/" + id);
      expect(missing.status, id).toBe(200);
      expect(await missing.json(), id).toMatchObject({ data: null });
    }
    expect((await get("/vault/notes/bad")).status).toBe(400);
    expect((await get("/public/vault/notes/" + project)).status).toBe(404);
  } finally {
    await close();
  }
});
