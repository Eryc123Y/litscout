import { restoreCompactPaper } from "./compact-details";
import { drizzle } from "drizzle-orm/d1";
import {
  editLibraryInput,
  editNoteInput,
  libraryCommands as schema,
  paperIdSchema,
  revision,
  type eventKind,
} from "@litscout/pipeline/library-contracts";
import type { Database } from "@litscout/db/database";
import { editLibraryItem, listLibrary } from "@litscout/db/library";
import { addNote, editNote, listNotes } from "@litscout/db/quick-notes";
import { recordEvent } from "@litscout/db/library-state";
import type { buildServer } from "@litscout/mcp/server";
import { z } from "zod";
import type { AppEnv } from "./env";
import { paperDetails, savePaper } from "./library-resolution";
import { trendsQuery } from "@litscout/pipeline/trends-contracts";
import { instanceTrends } from "./trends-api";
import { userDay } from "./instance-day";
import { allowLibraryWrite } from "./library-write-limit";
import { instanceInfo } from "./public-feed";

const kindFor = {
  read: "open",
  star: "star",
  unstar: "unstar",
  up: "rate_up",
  down: "rate_down",
  none: "rate_clear",
  skip: "skip",
  unskip: "unskip",
} satisfies Record<string, z.output<typeof eventKind>>;
type Server = ReturnType<typeof buildServer>;

/** A revisioned edit whose if_rev is stale: the message carries the current
 * revision so the agent can read the record again and retry. */
class StaleRevision extends Error {}
function versioned<T extends { rev?: number | null }>(
  result: { item?: T; current?: T | null },
  what: string,
) {
  if (result.item) return result.item;
  if (result.current)
    throw new StaleRevision(
      `The ${what} changed since that revision; its current revision is ${result.current.rev}. Check the current ${what} before retrying: ${JSON.stringify(result.current)}`,
    );
  return null;
}
const noteId = z.string().max(128).startsWith("note_");
const libraryEdit = z
  .object({
    paperId: paperIdSchema,
    if_rev: revision.shape.if_rev,
    status: editLibraryInput.shape.status,
    tags: editLibraryInput.shape.tags,
  })
  .refine((v) => v.status !== undefined || v.tags !== undefined, {
    message: "Give status, tags or both",
  });
const libraryRemoval = revision.extend({ paperId: paperIdSchema });
const notesQuery = z.object({
  target: paperIdSchema,
  after: noteId.optional(),
});
const noteEdit = editNoteInput.extend({ id: noteId });
const noteRemoval = revision.extend({ id: noteId });

function reply(data: unknown, error?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(error ? { error } : { result: data }),
      },
    ],
    ...(error ? { isError: true } : {}),
  };
}

export function registerLibraryTools(
  server: Server,
  env: AppEnv,
  {
    read,
    write,
    clientName,
    identity,
  }: { read: boolean; write: boolean; clientName?: string; identity: string },
) {
  const run = async (
    body: (db: Database) => Promise<unknown>,
    writeKind?: "save" | "activity",
    missing = "Paper not found",
  ) => {
    if (!env.DB) return reply(null, "Library unavailable");
    try {
      if (writeKind) {
        const result = await allowLibraryWrite(env, identity, writeKind);
        if (!result.allowed)
          return reply(
            null,
            `Too many requests. Retry after ${result.retryAfter} seconds.`,
          );
      }
      const result = await body(drizzle(env.DB));
      return result == null ? reply(null, missing) : reply(result);
    } catch (error) {
      return reply(
        null,
        error instanceof StaleRevision
          ? error.message
          : "The library operation could not be completed",
      );
    }
  };
  const source = clientName ? "mcp:" + clientName : "mcp";
  if (read) {
    server.registerTool(
      "get_trends",
      {
        description:
          "Read private monthly trends for a topic. Defaults to the first topic and current instance-local month. Includes 12 months of totals. Use nextPickOffset or nextActivityOffset to page the selected month's papers.",
        inputSchema: trendsQuery,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (query) => {
        if (!env.DB) return reply(null, "Trends unavailable");
        try {
          return reply(await instanceTrends(env.DB, env, query));
        } catch {
          return reply(null, "Trends could not be loaded");
        }
      },
    );
    server.registerTool(
      "search_library",
      {
        description:
          "Search the LitScout library and alphaXiv mirror by title or author (minimum 3 characters). Supports origin, folder, status, tag, venue and year filters, kind (preprint, conference or journal; a paper without a type counts as a preprint) and top (only the instance's top venues). Default 30 rows, maximum 100. Pass nextCursor as cursor for the next page.",
        inputSchema: schema.search_library,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) =>
        run((db) => listLibrary(db, args, instanceInfo(env).topVenues)),
    );
    server.registerTool(
      "get_paper",
      {
        description:
          "Get one paper by paper ID, DOI, arXiv ID, supported platform ID or URL. Returns metadata, summaries, links and quick notes. Use full=true for complete text.",
        inputSchema: schema.get_paper,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ ids, full }) => run(() => paperDetails(env, ids, full)),
    );
  }
  if (read)
    server.registerTool(
      "list_notes",
      {
        description:
          "List a paper's quick notes, newest first, 50 at a time; pass nextCursor as after. Each note has the rev that edit_note and delete_note need.",
        inputSchema: notesQuery,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ target, after }) =>
        run(async (db) => {
          const found = await listNotes(db, target, after);
          const items = found.slice(0, 50);
          return {
            items,
            nextCursor: found.length > 50 ? items.at(-1)!.id : null,
          };
        }),
    );
  if (!write) return;
  server.registerTool(
    "save_paper",
    {
      description:
        "Save a paper by ID or URL. Use dry_run to preview a match. For a title, choose a candidate and call again with its exact query. status to_read puts it in the Library's To read queue instead of Saved, and moves an entry that is still saved or to_read; an entry being read or done keeps its status.",
      inputSchema: schema.save_paper,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, dry_run, status }) =>
      run(() => savePaper(env, query, dry_run, source, status), "save"),
  );
  server.registerTool(
    "add_note",
    {
      description:
        "Add a quick Markdown note (1–4,000 characters) to a paper ID.",
      inputSchema: schema.add_note,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ target, bodyMd }) =>
      run(async (db) => {
        await restoreCompactPaper(env, target);
        return addNote(
          db,
          target,
          bodyMd,
          "mcp",
          new Date().toISOString(),
          clientName,
        );
      }, "activity"),
  );
  server.registerTool(
    "mark_paper",
    {
      description:
        "Set a paper's reading state by paper ID. Read, star, unstar, rate, skip or unskip. Ratings are up, down or none. skip hides the paper from the day's list and takes it out of To read (a paper saved or being read is kept and not skipped); unskip takes that back.",
      inputSchema: schema.mark_paper,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ paperId, action, rating }) =>
      run(async (db) => {
        await restoreCompactPaper(env, paperId);
        const now = new Date();
        return recordEvent(
          db,
          paperId,
          kindFor[rating ?? (action as Exclude<typeof action, "rate">)],
          userDay(env, now),
          now.toISOString(),
          source,
        );
      }, "activity"),
  );
  server.registerTool(
    "update_library_item",
    {
      description:
        "Change a saved paper's library status (to_read, reading, saved, read, archived) or its tags (replaces the list). Pass the rev from search_library or get_paper as if_rev; a stale rev is refused with the current one.",
      inputSchema: libraryEdit,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ paperId, if_rev, status, tags }) =>
      run(
        async (db) =>
          versioned(
            await editLibraryItem(
              db,
              paperId,
              if_rev,
              new Date().toISOString(),
              {
                if_rev,
                status,
                tags,
              },
            ),
            "library item",
          ),
        "activity",
      ),
  );
  server.registerTool(
    "remove_from_library",
    {
      description:
        "Remove a paper from the library by paper ID and its current rev. The paper stays in the feed; save_paper adds it back.",
      inputSchema: libraryRemoval,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ paperId, if_rev }) =>
      run(
        async (db) =>
          versioned(
            await editLibraryItem(
              db,
              paperId,
              if_rev,
              new Date().toISOString(),
              null,
            ),
            "library item",
          ),
        "activity",
      ),
  );
  server.registerTool(
    "edit_note",
    {
      description:
        "Replace a quick note's Markdown (1–4,000 characters) by note ID and its current rev from list_notes.",
      inputSchema: noteEdit,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ id, if_rev, bodyMd }) =>
      run(
        async (db) =>
          versioned(
            await editNote(db, id, if_rev, new Date().toISOString(), bodyMd),
            "note",
          ),
        "activity",
        "Note not found",
      ),
  );
  server.registerTool(
    "delete_note",
    {
      description:
        "Delete a quick note by note ID and its current rev from list_notes.",
      inputSchema: noteRemoval,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ id, if_rev }) =>
      run(
        async (db) =>
          versioned(
            await editNote(db, id, if_rev, new Date().toISOString(), null),
            "note",
          ),
        "activity",
        "Note not found",
      ),
  );
}
