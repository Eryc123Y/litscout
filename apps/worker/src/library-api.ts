import { restoreCompactPaper } from "./compact-details";
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import {
  addPaperInput,
  editLibraryInput,
  editNoteInput,
  eventInput,
  libraryQuery,
  linkChecksInput,
  linkLimit,
  noteInput,
  paperIdSchema,
  revision,
  stateQuery,
  saveInput,
} from "@litscout/pipeline/library-contracts";
import {
  addLibraryItem,
  editLibraryItem,
  listLibrary,
} from "@litscout/db/library";
import { readState, recordEvent } from "@litscout/db/library-state";
import { addNote, editNote, listNotes } from "@litscout/db/quick-notes";
import { linksDue, updateLinkChecks } from "@litscout/db/link-checks";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { userDay } from "./instance-day";
import { savePaper } from "./library-resolution";
import { zoteroImportPath } from "@litscout/pipeline/zotero-contracts";
import { importZotero } from "./zotero-import";
import { instanceInfo } from "./public-feed";

export const libraryApi = new Hono<WorkerBindings>();
const ok = (c: Context<WorkerBindings>, data: unknown) =>
  apiJson(c, { success: true, data });
const missing = (c: Context<WorkerBindings>) =>
  apiJson(
    c,
    {
      success: false,
      error: { code: "NOT_FOUND", message: "Paper or entry not found" },
    },
    404,
  );
const conflict = (c: Context<WorkerBindings>, current: unknown) =>
  apiJson(
    c,
    {
      success: false,
      error: {
        code: "CONFLICT",
        message: "The entry has changed. Reload it and try again.",
      },
      data: current,
    },
    409,
  );
const versioned = <T>(
  c: Context<WorkerBindings>,
  result: { item?: T; current?: T | null },
) =>
  result.item
    ? ok(c, result.item)
    : result.current
      ? conflict(c, result.current)
      : missing(c);
const db = (c: Context<WorkerBindings>) => drizzle(c.env.DB!);
const noteId = z.string().max(128).startsWith("note_");

for (const path of [
  "/library",
  "/library/*",
  "/notes",
  "/notes/*",
  "/events",
  "/state",
  "/ingest/links",
]) {
  libraryApi.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.DB)
      return apiJson(
        c,
        {
          success: false,
          error: { code: "UNAVAILABLE", message: "Database unavailable" },
        },
        503,
      );
    await next();
  });
}

libraryApi.get("/library", async (c) => {
  const query = libraryQuery.parse(c.req.query());
  const page = await listLibrary(
    db(c),
    query,
    instanceInfo(c.env).topVenues,
  ).catch((error: unknown) => {
    if (error instanceof z.ZodError) throw error;
    // Database error strings can include private search terms in SQL bindings.
    throw new Error("Could not read the library", { cause: error });
  });
  return ok(c, page);
});
libraryApi.post("/library", async (c) => {
  const v = addPaperInput.parse(await c.req.json());
  await restoreCompactPaper(c.env, v.paperId);
  const now = new Date();
  const item = await addLibraryItem(
    db(c),
    v.paperId,
    v.source,
    userDay(c.env, now),
    now.toISOString(),
    v.status,
  );
  return item ? ok(c, item) : missing(c);
});
libraryApi.post("/library/save", async (c) => {
  const v = saveInput.parse(await c.req.json());
  const result = await savePaper(c.env, v.query, v.dry_run, v.source, v.status);
  return result ? ok(c, result) : missing(c);
});
libraryApi.post(zoteroImportPath, importZotero);
libraryApi.patch("/library/:paperId", async (c) => {
  const v = editLibraryInput.parse(await c.req.json());
  return versioned(
    c,
    await editLibraryItem(
      db(c),
      paperIdSchema.parse(c.req.param("paperId")),
      v.if_rev,
      new Date().toISOString(),
      v,
    ),
  );
});
libraryApi.delete("/library/:paperId", async (c) => {
  const v = revision.parse(await c.req.json());
  return versioned(
    c,
    await editLibraryItem(
      db(c),
      paperIdSchema.parse(c.req.param("paperId")),
      v.if_rev,
      new Date().toISOString(),
      null,
    ),
  );
});

libraryApi.get("/state", async (c) =>
  ok(c, await readState(db(c), stateQuery.parse(c.req.query()))),
);
libraryApi.post("/events", async (c) => {
  const v = eventInput.parse(await c.req.json());
  await restoreCompactPaper(c.env, v.paperId);
  const now = new Date();
  const state = await recordEvent(
    db(c),
    v.paperId,
    v.kind,
    v.day ?? userDay(c.env, now),
    now.toISOString(),
    v.source,
  );
  return state ? ok(c, state) : missing(c);
});

libraryApi.get("/notes", async (c) => {
  const q = z
    .object({ target: paperIdSchema, after: noteId.optional() })
    .parse(c.req.query());
  const found = await listNotes(db(c), q.target, q.after);
  const items = found.slice(0, 50);
  return ok(c, {
    items,
    nextCursor: found.length > 50 ? items.at(-1)!.id : null,
  });
});
libraryApi.post("/notes", async (c) => {
  const v = noteInput.parse(await c.req.json());
  await restoreCompactPaper(c.env, v.target);
  const note = await addNote(
    db(c),
    v.target,
    v.bodyMd,
    v.origin,
    new Date().toISOString(),
  );
  return note ? ok(c, note) : missing(c);
});
libraryApi.patch("/notes/:id", async (c) => {
  const v = editNoteInput.parse(await c.req.json());
  return versioned(
    c,
    await editNote(
      db(c),
      noteId.parse(c.req.param("id")),
      v.if_rev,
      new Date().toISOString(),
      v.bodyMd,
    ),
  );
});
libraryApi.delete("/notes/:id", async (c) => {
  const v = revision.parse(await c.req.json());
  return versioned(
    c,
    await editNote(
      db(c),
      noteId.parse(c.req.param("id")),
      v.if_rev,
      new Date().toISOString(),
      null,
    ),
  );
});

libraryApi.get("/ingest/links", async (c) =>
  ok(c, {
    items: await linksDue(db(c), linkLimit.parse(c.req.query("limit"))),
  }),
);
libraryApi.post("/ingest/links", async (c) => {
  const v = linkChecksInput.parse(c.get("ingestBody"));
  const { updated, rowsWritten } = await updateLinkChecks(c.env.DB!, v.checks);
  return apiJson(c, {
    success: true,
    data: { updated },
    meta: { rowsWritten },
  });
});
