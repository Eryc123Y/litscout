import { trendsResponse } from "@litscout/pipeline/trends-contracts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ProtocolErrorCode,
  UnauthorizedError,
  type Client,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  libraryItemSchema,
  libraryPageSchema,
  quickNoteSchema,
  readingStateSchema,
  saveResultSchema,
} from "@litscout/pipeline/library-contracts";
import {
  suggestionsPage,
  suggestionResolution,
  workingPaperDetail,
  workingPapersPage,
} from "@litscout/pipeline/research-contracts";
import {
  ideasPage,
  projectsPage,
  queuedReply,
  vaultIdea,
  vaultNoteView,
} from "@litscout/pipeline/vault-contracts";
import { webDaySchema } from "@litscout/pipeline/web-contracts";
import { dayCountsSchema } from "@litscout/pipeline/read-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  callback,
  endpoint,
  issuePairingCode,
  mcpClient,
  mcpFixture,
  origin,
  revokeClient,
  type McpFixture,
} from "./helpers/mcp-conformance";

const lookup = ["lookup_paper"];
const libraryRead = ["search_library", "get_paper", "get_trends", "list_notes"];
const libraryWrite = [
  "save_paper",
  "add_note",
  "mark_paper",
  "update_library_item",
  "remove_from_library",
  "edit_note",
  "delete_note",
];
const feedRead = ["list_days", "get_day", "get_status"];
const publicResearch = [
  "search",
  "paper_links",
  "get_author",
  "coauthorship",
  "reviews",
  "venue",
];
const researchRead = [
  "research_context",
  "list_ideas",
  "get_idea",
  "get_note",
  "list_suggestions",
  "list_working_papers",
  "get_working_paper",
  "list_vault_requests",
];
const researchWrite = [
  "capture_idea",
  "request_link",
  "resolve_suggestion",
  "set_idea_status",
  "add_reading",
  "make_paper_note",
  "cancel_vault_request",
];

const lookupId = "10.1234/test";
const libraryId = "2611.08639";
const fixtureTitle = "A shared synthetic paper";
const syntheticPaper = z.object({
  title: z.literal(fixtureTitle),
  authors: z.array(z.object({ name: z.string() })).nonempty(),
});
const lookupResult = z.object({
  papers: z
    .array(syntheticPaper.extend({ requested: z.literal(lookupId) }))
    .nonempty(),
  not_found: z.tuple([]),
});
const provenance = z.object({
  notices: z.array(z.object({ level: z.string(), text: z.string() })),
  sources_used: z.array(z.string()).nonempty(),
  sources_skipped: z.array(
    z.object({ source: z.string(), reason: z.string() }),
  ),
});
const textResult = z.object({
  content: z.tuple([
    z.object({ type: z.literal("text"), text: z.string().min(1) }),
  ]),
});

function noteId(name: string) {
  return createHash("sha256").update(`PRIVATE_Vault/${name}.md`).digest("hex");
}
async function paperId(fixture: McpFixture) {
  const id = await fixture.db
    .prepare("SELECT paper_id FROM paper_ids WHERE scheme='arxiv' AND value=?")
    .bind(libraryId)
    .first<string>("paper_id");
  return z.string().startsWith("pap_").parse(id);
}
async function success(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, name).not.toBe(true);
  return JSON.parse(textResult.parse(response).content[0].text) as unknown;
}
async function toolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, name).toBe(true);
  return textResult.parse(response).content[0].text;
}
type Args = Record<string, unknown>;
/** Arguments read at call time, for tools that need a current revision. */
type LazyArgs = () => Promise<Args>;
const argsOf = async (args: Args | LazyArgs) =>
  typeof args === "function" ? args() : args;
function fixtureCalls(
  id: string,
  suggestion: string,
  request = "req_none",
  db?: D1Database,
) {
  const libraryRev = async () =>
    z
      .number()
      .parse(
        await db!
          .prepare(
            "SELECT rev FROM library_items WHERE paper_id=? AND deleted_at IS NULL",
          )
          .bind(id)
          .first<number>("rev"),
      );
  const note = async () =>
    z
      .object({ id: z.string(), rev: z.number() })
      .parse(
        await db!
          .prepare(
            "SELECT id,rev FROM notes WHERE target_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1",
          )
          .bind(id)
          .first(),
      );
  const idea = noteId("Idea");
  const draft = noteId("Draft");
  const project = noteId("Project");
  type Case = [Args | LazyArgs, Args, z.ZodType];
  return {
    lookup_paper: [{ ids: lookupId }, { ids: [] }, lookupResult],
    search_library: [
      { q: "Forcing" },
      { limit: 101 },
      libraryPageSchema.refine((page) =>
        page.items.some((item) => "paperId" in item && item.paperId === id),
      ),
    ],
    get_paper: [
      { ids: libraryId },
      { ids: 7 },
      z.object({
        record: z.object({ paperId: z.literal(id), title: z.string() }),
        links: z.array(z.object({ url: z.url() })).nonempty(),
        summary: z.array(z.object({ tldr: z.string() })).nonempty(),
        notes: z.array(quickNoteSchema).nonempty(),
        notesNextCursor: z.null(),
      }),
    ],
    get_trends: [
      { topic: "Vision", month: "2026-11" },
      { month: "2026-99" },
      trendsResponse,
    ],
    save_paper: [
      { query: id },
      { query: "" },
      saveResultSchema.refine((r) => r.status === "saved" && r.paperId === id),
    ],
    add_note: [
      { target: id, bodyMd: "Fixture note" },
      { target: id, bodyMd: "   " },
      quickNoteSchema.extend({
        targetId: z.literal(id),
        origin: z.literal("mcp"),
        bodyMd: z.literal("Fixture note"),
      }),
    ],
    mark_paper: [
      { paperId: id, action: "rate", rating: "up" },
      { paperId: id, action: "rate" },
      readingStateSchema.extend({
        paperId: z.literal(id),
        rating: z.literal("up"),
      }),
    ],
    list_days: [
      { limit: 5 },
      { before: "2026-02-30" },
      z
        .object({
          items: z
            .array(webDaySchema.extend({ behind: z.boolean().optional() }))
            .max(5),
          nextBefore: z.string().nullable(),
        })
        .refine((page) => page.items.some((d) => d.day === "2026-11-17")),
    ],
    get_day: [
      { day: "2026-11-17", limit: 2 },
      { day: "2026-11-17", limit: 0 },
      z.object({
        day: z.literal("2026-11-17"),
        status: z.string(),
        language: z.enum(["en", "zh"]),
        counts: dayCountsSchema,
        brief: z.object({ day: z.literal("2026-11-17") }).passthrough(),
        papers: z.object({
          items: z
            .array(z.object({ paperId: z.string(), title: z.string() }))
            .min(1)
            .max(2),
          nextCursor: z.string().nullable(),
        }),
      }),
    ],
    get_status: [
      {},
      { days: 0 },
      z.object({
        today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        budget: z.object({
          day: z.string(),
          used: z.number(),
          limit: z.number(),
          remaining: z.number(),
          resetAt: z.string(),
        }),
        runs: z.array(z.object({ day: z.string() }).passthrough()),
        behind: z.array(z.string()),
        vault: z.object({}).passthrough(),
      }),
    ],
    list_notes: [
      { target: id },
      { target: "" },
      z.object({
        items: z.array(quickNoteSchema).nonempty(),
        nextCursor: z.string().nullable(),
      }),
    ],
    update_library_item: [
      async () => ({
        paperId: id,
        if_rev: await libraryRev(),
        status: "reading",
        tags: ["mcp"],
      }),
      { paperId: id, if_rev: 0, status: "reading" },
      libraryItemSchema.extend({ status: z.literal("reading") }),
    ],
    remove_from_library: [
      async () => ({ paperId: id, if_rev: await libraryRev() }),
      { paperId: id },
      z.object({ paperId: z.literal(id) }).passthrough(),
    ],
    edit_note: [
      async () => {
        const { id: noteId, rev } = await note();
        return { id: noteId, if_rev: rev, bodyMd: "Edited over MCP" };
      },
      { id: "note_x", if_rev: 0, bodyMd: "x" },
      quickNoteSchema.extend({ bodyMd: z.literal("Edited over MCP") }),
    ],
    delete_note: [
      async () => {
        const { id: noteId, rev } = await note();
        return { id: noteId, if_rev: rev };
      },
      { id: "note_x" },
      z.object({ id: z.string() }).passthrough(),
    ],
    search: [
      { query: "synthetic" },
      {},
      z.object({ papers: z.array(syntheticPaper).nonempty() }),
    ],
    paper_links: [
      { id: "CorpusId:1", direction: "citations" },
      { id: "CorpusId:1", direction: "invalid" },
      z.string().includes(fixtureTitle),
    ],
    get_author: [
      { name_or_id: "Alex Example", include_papers: true },
      { name_or_id: "" },
      z.string().includes(fixtureTitle),
    ],
    coauthorship: [
      { authors: ["Alex Example", "Sam Example"] },
      { author_a: "Alex Example" },
      z.string().includes(fixtureTitle),
    ],
    reviews: [
      { query: "syntheticForum" },
      { query: "" },
      z.object({
        forum: z.literal("syntheticForum"),
        ratings: z.object({ mean: z.literal(7), stddev: z.literal(1) }),
        reviews: z.array(z.object({ rating: z.number() })).length(2),
      }),
    ],
    venue: [
      { query: "SSW" },
      { query: "" },
      z.object({
        matches: z
          .array(
            z.object({
              acronym: z.literal("SSW"),
              ranks: z
                .array(
                  z.object({
                    system: z.enum(["CCF", "ICORE"]),
                    rank: z.string(),
                    year: z.number(),
                    source: z.url(),
                  }),
                )
                .nonempty(),
            }),
          )
          .nonempty(),
      }),
    ],
    research_context: [
      { projectId: project },
      { projectId: "bad" },
      projectsPage.refine((page) => page.items[0]?.id === project),
    ],
    list_ideas: [
      {},
      { after: "bad" },
      ideasPage.refine((page) => page.items[0]?.id === idea),
    ],
    get_idea: [
      { id: idea },
      { id: "bad" },
      vaultIdea.extend({ id: z.literal(idea) }),
    ],
    get_note: [
      { id: project },
      { id: "bad" },
      vaultNoteView.extend({
        id: z.literal(project),
        kind: z.literal("project"),
        bodyMd: z.string().startsWith("# PRIVATE_Vision plan"),
      }),
    ],
    list_suggestions: [
      { day: "2026-11-17", status: "new" },
      { day: "2026-02-30" },
      suggestionsPage.refine((page) =>
        page.items.some((item) => item.id === suggestion),
      ),
    ],
    list_working_papers: [
      {},
      { after: 1 },
      workingPapersPage.refine((page) => page.items[0]?.id === draft),
    ],
    get_working_paper: [
      { id: draft },
      { id: "bad" },
      workingPaperDetail.extend({ id: z.literal(draft) }),
    ],
    list_vault_requests: [
      {},
      { kind: "bogus" },
      z.object({
        items: z
          .array(z.object({ id: z.string(), kind: z.string() }).passthrough())
          .refine((items) => items.some((item) => item.kind === "capture")),
        total: z.number().int().min(1),
        truncated: z.literal(false),
      }),
    ],
    set_idea_status: [
      { targetNoteId: idea, status: "exploring" },
      { targetNoteId: idea, status: "done" },
      queuedReply,
    ],
    add_reading: [
      { targetNoteId: draft, paperId: id },
      { targetNoteId: draft },
      queuedReply,
    ],
    make_paper_note: [{ paperId: id }, { paperId: "" }, queuedReply],
    cancel_vault_request: [
      { id: request },
      { id: "" },
      z.object({ cancelled: z.literal(true) }),
    ],
    capture_idea: [{ title: "Conformance idea" }, { title: "" }, queuedReply],
    request_link: [
      { targetNoteId: idea, paperId: id },
      { targetNoteId: "bad", paperId: id },
      queuedReply,
    ],
    resolve_suggestion: [
      { id: suggestion, action: "accept" },
      { id: suggestion, action: "invalid" },
      suggestionResolution.extend({
        status: z.literal("accepted"),
        requestId: z.string(),
      }),
    ],
  } satisfies Record<string, Case>;
}

async function withToken(
  fixture: McpFixture,
  token: string,
  run: (client: Client) => Promise<void>,
  ip?: string,
) {
  const { client, transport } = mcpClient(fixture, token, ip);
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("litscout");
    await run(client);
  } finally {
    await client.close();
  }
}

describe.each([false, true])(
  "Streamable HTTP with researchTools=%s",
  (enabled) => {
    let fixture: McpFixture;
    beforeAll(async () => {
      fixture = await mcpFixture(enabled);
    });
    afterAll(async () => fixture?.dispose());

    it.each([
      ["A", ["read"]],
      ["B", ["write"]],
      ["C", ["read", "write"]],
    ] as const)(
      "lists authorized tools for token %s with scopes %j",
      async (suffix, scopes) => {
        const token = await fixture.token(suffix, [...scopes]);
        await withToken(fixture, token, async (client) => {
          const read = scopes.some((scope) => scope === "read");
          const write = scopes.some((scope) => scope === "write");
          const { tools, nextCursor } = await client.listTools();
          expect(nextCursor).toBeUndefined();
          if (read) {
            // Vault state and digest suggestions are research data: they
            // need research tools on, and the vault state needs write too.
            const status = z
              .object({ result: z.record(z.string(), z.unknown()) })
              .parse(await success(client, "get_status", {}));
            expect("vault" in status.result).toBe(enabled && write);
            const day = z
              .object({
                result: z.object({
                  day: z.string(),
                  brief: z
                    .object({ suggestions: z.array(z.unknown()).optional() })
                    .passthrough(),
                }),
              })
              .parse(await success(client, "get_day", { limit: 1 }));
            expect(day.result.day).toBe("2026-11-17");
            const titles = async (args: Record<string, unknown>) =>
              z
                .object({
                  result: z.object({
                    papers: z.object({
                      items: z.array(z.object({ title: z.string() })),
                    }),
                  }),
                })
                .parse(await success(client, "get_day", args))
                .result.papers.items.map((item) => item.title);
            const outside = "Outside Every Topic: A Fixture Paper";
            expect(await titles({ limit: 10 })).not.toContain(outside);
            expect(await titles({ q: "Outside Every" })).toContain(outside);
            expect(await titles({ shortlisted: false, limit: 10 })).toContain(
              outside,
            );
            if (!enabled) expect(day.result.brief.suggestions).toBeUndefined();
          }
          expect(tools.map(({ name }) => name).sort()).toEqual(
            [
              ...(read ? [...lookup, ...libraryRead, ...feedRead] : []),
              ...(write ? libraryWrite : []),
              ...(enabled && read ? [...publicResearch, ...researchRead] : []),
              ...(enabled && write ? researchWrite : []),
            ].sort(),
          );
          if (!read || !write) {
            const id = await paperId(fixture);
            const calls = fixtureCalls(id, "sug_example");
            for (const name of [
              ...(!read
                ? [...lookup, ...libraryRead, ...feedRead]
                : libraryWrite),
              ...(enabled
                ? !read
                  ? [...publicResearch, ...researchRead]
                  : researchWrite
                : []),
            ] as Array<keyof typeof calls>) {
              await expect(
                client.callTool({
                  name,
                  arguments:
                    typeof calls[name][0] === "function" ? {} : calls[name][0],
                }),
                name,
              ).rejects.toMatchObject({
                code: ProtocolErrorCode.InvalidParams,
                message: expect.stringContaining("not found"),
              });
            }
          }
        });
      },
    );

    if (!enabled) return;

    it("validates the published schemas and successful and invalid calls for every tool", async () => {
      const id = await paperId(fixture);
      const suggestion = await fixture.db
        .prepare("SELECT id FROM suggestions ORDER BY id LIMIT 1")
        .first<string>("id");
      const request = await fixture.db
        .prepare(
          "SELECT id FROM vault_requests WHERE state='queued' AND kind='capture' ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .first<string>("id");
      const calls = fixtureCalls(
        id,
        z.string().min(1).parse(suggestion),
        z.string().min(1).parse(request),
        fixture.db,
      );
      const token = await fixture.token("E", ["read", "write"]);
      const validator = new AjvJsonSchemaValidator();
      const guide = await readFile("docs/self-host.md", "utf8");
      const examples = [
        ...guide.matchAll(/^\| `(\w+)` +\| [^|]*\| `(\{.*?\})` +\|$/gm),
      ];
      expect(examples.map(([, name]) => name).sort()).toEqual(
        Object.keys(calls).sort(),
      );
      const guideArgs = new Map(
        examples.map(([, name, example]) => [
          name,
          JSON.parse(
            example!
              .replaceAll('"IDEA_ID"', JSON.stringify(noteId("Idea")))
              .replaceAll('"DRAFT_ID"', JSON.stringify(noteId("Draft")))
              .replaceAll('"SUGGESTION_ID"', JSON.stringify(suggestion))
              .replaceAll('"REQUEST_ID"', JSON.stringify(request)),
          ) as unknown,
        ]),
      );
      await withToken(
        fixture,
        token,
        async (client) => {
          const { tools } = await client.listTools();
          expect(tools.map(({ name }) => name).sort()).toEqual(
            Object.keys(calls).sort(),
          );
          for (const tool of tools) {
            const name = tool.name as keyof typeof calls;
            const [lazy, invalid, resultShape] = calls[name];
            const valid = await argsOf(lazy);
            expect(tool.description, name).toMatch(/\S/);
            expect(tool.inputSchema.type, name).toBe("object");
            const validate = validator.getValidator(
              tool.inputSchema as Parameters<typeof validator.getValidator>[0],
            );
            expect(validate(valid).valid, name).toBe(true);
            expect(validate(invalid).valid, name).toBe(false);
            expect(
              validate(guideArgs.get(name)).valid,
              `guide example for ${name}`,
            ).toBe(true);
            expect(await toolError(client, name, invalid), name).toMatch(
              /invalid arguments/i,
            );
            const result = await success(client, name, valid);
            z.object({ result: resultShape }).parse(result);
            if ([...lookup, ...publicResearch].includes(name))
              provenance.parse(result);
          }

          for (const [name, args] of [
            ["get_idea", { id: "f".repeat(64) }],
            ["get_note", { id: "f".repeat(64) }],
            ["get_working_paper", { id: "f".repeat(64) }],
          ] as const) {
            expect(await toolError(client, name, args), name).toMatch(
              /not found/i,
            );
          }
        },
        // Its own address: this test alone makes more calls than one
        // address may in a minute, and later tests share the default one.
        "198.51.100.20",
      );
    });

    it("shares the HTTP save and activity limits for the same write token", async () => {
      const id = await paperId(fixture);
      const token = await fixture.token("F", ["write"]);
      const post = (path: string, body: unknown) =>
        fixture.request("/api/v1" + path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      await withToken(
        fixture,
        token,
        async (client) => {
          const save = { query: id, dry_run: true };
          const mark = { paperId: id, action: "star" };
          const note = { target: id, bodyMd: "HTTP fixture note" };
          expect((await post("/library/save", save)).ok).toBe(true);
          expect((await post("/notes", note)).ok).toBe(true);
          for (let i = 0; i < 19; i++)
            await success(client, "save_paper", save);
          expect(await toolError(client, "save_paper", save)).toMatch(
            /Retry after [1-9]\d* seconds/,
          );
          for (let i = 0; i < 59; i++)
            await success(client, "mark_paper", mark);
          for (const path of ["/library/save", "/notes"]) {
            const response = await post(
              path,
              path.endsWith("save") ? save : note,
            );
            expect(response.status).toBe(429);
            expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(
              0,
            );
            expect(await response.json()).toMatchObject({
              error: { code: "RATE_LIMITED" },
            });
          }
          expect(
            await toolError(client, "capture_idea", { title: "Over limit" }),
          ).toMatch(/Retry after [1-9]\d* seconds/);
        },
        "192.0.2.5",
      );
    });

    it("rejects unknown, expired, revoked and malformed API tokens during initialize", async () => {
      const past = "2000-01-01T00:00:00.000Z";
      for (const token of [
        "lsk_" + "Z".repeat(52),
        await fixture.token("G", ["read"], { expiresAt: past }),
        await fixture.token("H", ["read"], { revokedAt: past }),
        "lsk_invalid",
      ]) {
        const { client, transport } = mcpClient(fixture, token);
        try {
          await expect(client.connect(transport)).rejects.toBeInstanceOf(
            UnauthorizedError,
          );
        } finally {
          await client.close();
        }
      }
    });

    it("refuses an ingest-only token on the MCP endpoint", async () => {
      const token = await fixture.token("D", ["ingest"]);
      const response = await fixture.request(endpoint, {
        headers: { authorization: "Bearer " + token },
      });
      expect(response.status).toBe(403);
    });

    it("refuses a stale revision and shows the current record", async () => {
      const id = await paperId(fixture);
      const token = await fixture.token("J", ["read", "write"]);
      await withToken(
        fixture,
        token,
        async (client) => {
          await success(client, "save_paper", { query: id });
          const rev = z
            .number()
            .parse(
              await fixture.db
                .prepare(
                  "SELECT rev FROM library_items WHERE paper_id=? AND deleted_at IS NULL",
                )
                .bind(id)
                .first<number>("rev"),
            );
          await success(client, "update_library_item", {
            paperId: id,
            if_rev: rev,
            status: "read",
          });
          const stale = await toolError(client, "update_library_item", {
            paperId: id,
            if_rev: rev,
            status: "archived",
          });
          expect(stale).toMatch(/changed since that revision/);
          expect(stale).toContain(String(rev + 1));
          expect(stale).toContain('\\"status\\":\\"read\\"');

          await success(client, "add_note", { target: id, bodyMd: "First" });
          const notes = z
            .object({
              result: z.object({
                items: z.array(z.object({ id: z.string(), rev: z.number() })),
              }),
            })
            .parse(await success(client, "list_notes", { target: id }));
          const note = notes.result.items[0]!;
          await success(client, "edit_note", {
            id: note.id,
            if_rev: note.rev,
            bodyMd: "Second",
          });
          const staleNote = await toolError(client, "edit_note", {
            id: note.id,
            if_rev: note.rev,
            bodyMd: "Third",
          });
          expect(staleNote).toMatch(/changed since that revision/);
          expect(staleNote).toContain("Second");
          expect(
            await toolError(client, "delete_note", {
              id: "note_missing",
              if_rev: 1,
            }),
          ).toContain("Note not found");
        },
        "198.51.100.21",
      );
    });

    it("discovers OAuth, registers, pairs with consent and PKCE, and refuses the revoked grant", async () => {
      const challenge = await fixture.request(endpoint);
      expect(challenge.status).toBe(401);
      const discovered = challenge.headers
        .get("www-authenticate")
        ?.match(/resource_metadata="([^"]+)"/)?.[1];
      expect(discovered).toBe(
        origin + "/.well-known/oauth-protected-resource/mcp",
      );
      expect(await (await fixture.request(discovered!)).json()).toMatchObject({
        resource: endpoint.href,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
      expect(
        await (
          await fixture.request("/.well-known/oauth-authorization-server")
        ).json(),
      ).toMatchObject({
        issuer: origin,
        registration_endpoint: origin + "/register",
        authorization_endpoint: origin + "/authorize",
        token_endpoint: origin + "/token",
        code_challenge_methods_supported: ["S256"],
      });

      let registration: StoredOAuthClientInformation | undefined;
      let tokens: StoredOAuthTokens | undefined;
      let verifier = "";
      let authorization: URL | undefined;
      let discovery: OAuthDiscoveryState | undefined;
      const oauth: OAuthClientProvider = {
        redirectUrl: callback,
        clientMetadata: {
          client_name: "Fixture connector",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "read write",
        },
        state: () => "fixture-callback-state",
        clientInformation: () => registration,
        saveClientInformation: (info) => {
          registration = info;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
          tokens = value;
        },
        redirectToAuthorization: (url) => {
          authorization = url;
        },
        codeVerifier: () => verifier,
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        discoveryState: () => discovery,
        saveDiscoveryState: (value) => {
          discovery = value;
        },
      };
      const { client, transport } = mcpClient(fixture, oauth);
      try {
        await expect(client.connect(transport)).rejects.toBeInstanceOf(
          UnauthorizedError,
        );
        expect(registration?.client_id).toBeTruthy();
        expect(authorization?.pathname).toBe("/authorize");
        expect(authorization?.searchParams.get("code_challenge_method")).toBe(
          "S256",
        );
        expect(authorization?.searchParams.get("scope")).toBe("read write");
        expect(authorization?.searchParams.get("resource")).toBe(endpoint.href);

        const code = await issuePairingCode(fixture);
        const consent = await fixture.request(authorization!);
        expect(consent.status).toBe(200);
        const html = await consent.text();
        expect(html).toContain(
          "Read library and notes, Change library and notes",
        );
        const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
        expect(handle).toBeTruthy();
        const approved = await fixture.request("/authorize", {
          method: "POST",
          headers: {
            origin,
            cookie: consent.headers
              .getSetCookie()
              .map((cookie) => cookie.split(";")[0])
              .join("; "),
          },
          body: new URLSearchParams({
            handle: handle!,
            code,
            decision: "approve",
          }),
        });
        expect(approved.status).toBe(302);
        const redirect = new URL(approved.headers.get("location")!);
        expect(redirect.origin + redirect.pathname).toBe(callback);
        expect(redirect.searchParams.get("state")).toBe(
          "fixture-callback-state",
        );
        expect(redirect.searchParams.get("iss")).toBe(origin);
        await transport.finishAuth(redirect.searchParams);
        expect(tokens?.access_token).toBeTruthy();
        expect(tokens?.scope).toBe("read write");
      } finally {
        await client.close();
      }

      const token = tokens!.access_token;
      await withToken(fixture, token, async (paired) => {
        expect(
          (await paired.listTools()).tools.map(({ name }) => name),
        ).toEqual(
          expect.arrayContaining([
            ...libraryRead,
            ...feedRead,
            ...libraryWrite,
            ...researchRead,
            ...researchWrite,
          ]),
        );
        const id = await paperId(fixture);
        expect(
          await success(paired, "add_note", {
            target: id,
            bodyMd: "Paired note",
          }),
        ).toMatchObject({
          result: {
            bodyMd: "Paired note",
            client: "Fixture connector (unverified)",
            origin: "mcp",
          },
        });
        expect(
          (await revokeClient(fixture, registration!.client_id)).status,
        ).toBe(200);
        await expect(
          paired.callTool({ name: "get_paper", arguments: { ids: libraryId } }),
        ).rejects.toBeInstanceOf(Error);
        const refused = await fixture.request(endpoint, {
          headers: { authorization: "Bearer " + token },
        });
        expect([401, 403]).toContain(refused.status);
      });
    });
  },
);
