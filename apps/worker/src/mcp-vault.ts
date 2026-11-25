import { vaultProjectPage } from "./vault-project-page";
import { restoreCompactPaper } from "./compact-details";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import type { buildServer } from "@litscout/mcp/server";
import {
  newVaultRequest,
  vaultHash,
  type NewVaultRequest,
} from "@litscout/pipeline/vault-contracts";
import {
  listVaultIdeas,
  vaultIdeaById,
  vaultNoteById,
} from "@litscout/db/vault-reads";
import {
  cancelVaultRequest,
  createVaultRequest,
  queuedVaultRequests,
  VaultRequestError,
} from "@litscout/db/vault-requests";
import {
  researchPage,
  researchPageSize,
  suggestionAction,
  suggestionsQuery,
} from "@litscout/pipeline/research-contracts";
import { vaultId } from "@litscout/pipeline/vault-contracts";
import { listSuggestions, resolveSuggestion } from "@litscout/db/suggestions";
import {
  getWorkingPaper,
  listWorkingPapers,
} from "@litscout/db/working-papers";
import type { Database } from "@litscout/db/database";
import { instanceInfo } from "./public-feed";
import { userDay } from "./instance-day";
import { allowLibraryWrite } from "./library-write-limit";
import type { AppEnv } from "./env";

function reply(value: unknown, error?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(error ? { error } : { result: value }),
      },
    ],
    ...(error ? { isError: true } : {}),
  };
}
const capture = newVaultRequest.options[0].omit({ kind: true });
const link = newVaultRequest.options[1].omit({ kind: true });
const setStatus = newVaultRequest.options[2].omit({ kind: true });
const addReading = newVaultRequest.options[3].omit({ kind: true });
const paperNote = newVaultRequest.options[4].omit({ kind: true });
const requestKind = z.enum([
  "capture",
  "link_paper",
  "set_status",
  "add_reading",
  "make_paper_note",
]);
const requestsQuery = z.object({ kind: requestKind.optional() });
const cursor = z.object({ after: vaultHash.optional() });
const note = z.object({ id: vaultHash });
const readAnnotations = { readOnlyHint: true, openWorldHint: false };
const context = z.object({
  projectId: vaultHash.optional(),
  after: vaultHash.optional(),
});

export function registerVaultTools(
  server: ReturnType<typeof buildServer>,
  env: AppEnv,
  access: {
    read: boolean;
    write: boolean;
    identity: string;
    clientName?: string;
  },
) {
  if (env.MCP_RESEARCH_TOOLS !== "true") return;
  const read = async (
    query: (db: Database) => Promise<unknown>,
    missing = "Indexed item not found",
  ) => {
    if (!env.DB) return reply(null, "Vault index unavailable");
    try {
      const result = await query(drizzle(env.DB));
      return result == null ? reply(null, missing) : reply(result);
    } catch {
      return reply(null, "Vault index unavailable");
    }
  };
  if (access.read) {
    server.registerTool(
      "research_context",
      {
        description:
          "Read up to five vault projects with their indexed ideas, papers and radar hits. Pass next as after for another page, or select one project by projectId.",
        inputSchema: context,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ projectId, after }) =>
        read(async (db) => vaultProjectPage(db, after, projectId)),
    );
    server.registerTool(
      "list_ideas",
      {
        description:
          "List up to 25 indexed vault ideas with their paths. Use next as after to continue.",
        inputSchema: cursor,
        annotations: readAnnotations,
      },
      async ({ after }) =>
        read(async (db) =>
          researchPage(
            await listVaultIdeas(db, after ?? "", researchPageSize + 1),
          ),
        ),
    );
    server.registerTool(
      "get_idea",
      {
        description: "Read one indexed idea and its vault path by note ID.",
        inputSchema: note,
        annotations: readAnnotations,
      },
      async ({ id }) => read((db) => vaultIdeaById(db, id), "Idea not found"),
    );
    server.registerTool(
      "get_note",
      {
        description:
          "Read a project, idea or working paper note by note ID: title, vault path and its Markdown body. bodyMd is null when the owner keeps bodies in the vault only. Read-only: edit notes in the vault.",
        inputSchema: note,
        annotations: readAnnotations,
      },
      async ({ id }) => read((db) => vaultNoteById(db, id), "Note not found"),
    );
    server.registerTool(
      "list_suggestions",
      {
        description:
          "List up to 25 private digest suggestions. Filter by ISO day and status, and use next as after to continue.",
        inputSchema: suggestionsQuery,
        annotations: readAnnotations,
      },
      async (query) =>
        read(async (db) =>
          researchPage(await listSuggestions(db, query, researchPageSize + 1)),
        ),
    );
    server.registerTool(
      "list_working_papers",
      {
        description:
          "List up to 25 indexed working papers with their vault paths. Use next as after to continue.",
        inputSchema: cursor,
        annotations: readAnnotations,
      },
      async ({ after }) =>
        read(async (db) =>
          researchPage(
            await listWorkingPapers(db, after ?? "", researchPageSize + 1),
          ),
        ),
    );
    server.registerTool(
      "get_working_paper",
      {
        description:
          "Read a working paper's index, ideas in note order, reading list and up to eight related feed papers from the past seven days.",
        inputSchema: note,
        annotations: readAnnotations,
      },
      async ({ id }) =>
        read(
          (db) => getWorkingPaper(db, id, userDay(env, new Date())),
          "Working paper not found",
        ),
    );
  }
  if (access.read)
    server.registerTool(
      "list_vault_requests",
      {
        description:
          "List up to 50 requests waiting for vault sync (captures, paper links, idea status changes, reading-list additions, paper notes), oldest first, with the queue's total. They reach the Obsidian vault only when vault sync runs with vault writing on.",
        inputSchema: requestsQuery,
        annotations: readAnnotations,
      },
      async ({ kind }) =>
        read(async (db) => {
          const [queue, total] = await Promise.all([
            queuedVaultRequests(
              db,
              new Date().toISOString(),
              instanceInfo(env).language,
            ),
            env
              .DB!.prepare(
                "SELECT count(*) AS n FROM vault_requests WHERE state='queued'",
              )
              .first<number>("n"),
          ]);
          return {
            // The list holds the oldest 50 waiting requests; the queue holds
            // up to 200, some of which may be being applied right now.
            total: total ?? 0,
            truncated: (total ?? 0) > queue.length,
            items: queue
              .filter((request) => !kind || request.kind === kind)
              .map((request) => ({
                id: request.id,
                kind: request.kind,
                ...("title" in request && request.title
                  ? { title: request.title }
                  : {}),
                ...("status" in request && request.status
                  ? { status: request.status }
                  : {}),
                ...("topic" in request && request.topic
                  ? { topic: request.topic }
                  : {}),
                ...("target" in request && request.target
                  ? { target: request.target }
                  : {}),
                ...("paper" in request && request.paper
                  ? {
                      paper: {
                        id: request.paper.id,
                        title: request.paper.title,
                      },
                    }
                  : {}),
              })),
          };
        }),
    );
  if (!access.write) return;
  const origin = access.clientName ? "mcp:" + access.clientName : "mcp";
  async function write(operation: (db: Database) => Promise<unknown>) {
    if (!env.DB) return reply(null, "Vault request queue unavailable");
    try {
      const limit = await allowLibraryWrite(env, access.identity, "activity");
      if (!limit.allowed)
        return reply(
          null,
          "Too many requests. Retry after " + limit.retryAfter + " seconds.",
        );
      return reply(await operation(drizzle(env.DB)));
    } catch (error) {
      return reply(
        null,
        error instanceof VaultRequestError
          ? error.message
          : "The vault request could not be queued.",
      );
    }
  }
  const queue = (input: NewVaultRequest) =>
    write(async (db) => {
      if ("paperId" in input && input.paperId)
        await restoreCompactPaper(env, input.paperId);
      const { id, state } = await createVaultRequest(
        db,
        input,
        new Date().toISOString(),
        origin,
      );
      return { id, state };
    });
  const annotations = { destructiveHint: false, openWorldHint: false };
  server.registerTool(
    "capture_idea",
    {
      description:
        "Queue an idea or a note for the vault Inbox with a title, an optional Markdown body (up to 10,000 characters) and an optional paper ID.",
      inputSchema: capture,
      annotations,
    },
    async (args) => queue({ kind: "capture", ...args }),
  );
  server.registerTool(
    "request_link",
    {
      description:
        "Queue an arXiv or DOI entry in an idea note's papers list by indexed note ID and LitScout paper ID.",
      inputSchema: link,
      annotations,
    },
    async (args) => queue({ kind: "link_paper", ...args }),
  );
  server.registerTool(
    "set_idea_status",
    {
      description:
        "Queue a status change for an indexed idea note by note ID: seed, exploring, in-paper, parked or dropped (the Ideas board columns).",
      inputSchema: setStatus,
      annotations,
    },
    async (args) => queue({ kind: "set_status", ...args }),
  );
  server.registerTool(
    "add_reading",
    {
      description:
        "Queue a LitScout paper for an indexed working paper's reading list by working paper ID and paper ID.",
      inputSchema: addReading,
      annotations,
    },
    async (args) => queue({ kind: "add_reading", ...args }),
  );
  server.registerTool(
    "make_paper_note",
    {
      description:
        "Queue a new vault note for a LitScout paper, optionally filed under a topic.",
      inputSchema: paperNote,
      annotations,
    },
    async (args) => queue({ kind: "make_paper_note", ...args }),
  );
  server.registerTool(
    "cancel_vault_request",
    {
      description:
        "Cancel a queued vault request by ID before vault sync starts applying it.",
      inputSchema: z.object({ id: vaultId }),
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      write(async (db) => {
        const { ended } = await cancelVaultRequest(
          db,
          id,
          new Date().toISOString(),
        );
        if (!ended)
          throw new VaultRequestError(
            "The request is already being applied or has been resolved.",
          );
        return { cancelled: true };
      }),
  );
  server.registerTool(
    "resolve_suggestion",
    {
      description:
        "Accept a digest suggestion into the vault request queue, or dismiss it by suggestion ID.",
      inputSchema: z.object({ id: vaultId, action: suggestionAction }),
      annotations,
    },
    async ({ id, action }) =>
      write(async (db) => {
        const { status, requestId } = await resolveSuggestion(
          db,
          id,
          action,
          new Date().toISOString(),
          origin,
          instanceInfo(env).language,
        );
        return { status, requestId };
      }),
  );
}
