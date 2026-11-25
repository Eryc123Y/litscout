import { restoreCompactPaper } from "./compact-details";
import { Hono, type Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import {
  captureEdit,
  indexBatch,
  indexCommit,
  indexTitleBackfill,
  newVaultRequest,
  resolveVaultRequest,
  syncReport,
  vaultClaim,
  vaultConventionSettings,
  vaultHash,
  vaultId,
  vaultMatch,
} from "@litscout/pipeline/vault-contracts";
import {
  getVaultIndex,
  hashVaultText,
  publishVaultIndex,
  stageVaultIndex,
  vaultIndexIds,
} from "@litscout/db/vault-index";
import { backfillVaultTitleKeys } from "@litscout/db/vault-title-matches";
import {
  listVaultIdeas,
  listVaultProjects,
  lookupVaultMatches,
  paperVaultNote,
  readVaultDigest,
  readVaultPapers,
  vaultIdeaById,
  vaultNoteById,
} from "@litscout/db/vault-reads";
import {
  cancelVaultRequest,
  editCapture,
  pendingCaptures,
  claimVaultRequestKind,
  claimedCapture,
  clearRejectedMove,
  createVaultRequest,
  getVaultStatus,
  queuedVaultRequests,
  recordVaultSync,
  resolveVaultRequest as resolve,
  VaultRequestError,
} from "@litscout/db/vault-requests";
import {
  researchPage,
  researchPageSize,
  suggestionAction,
  suggestionsQuery,
} from "@litscout/pipeline/research-contracts";
import {
  listWorkingPapers,
  getWorkingPaper,
} from "@litscout/db/working-papers";
import { listSuggestions, resolveSuggestion } from "@litscout/db/suggestions";
import { userDay } from "./instance-day";
import { invalidJson } from "./api-errors";
import { apiJson } from "./api-response";
import type { WorkerBindings } from "./api-auth";
import { vaultProjectPage } from "./vault-project-page";
import { instanceInfo } from "./public-feed";
import { unavailable } from "./diagnostics";

type C = Context<WorkerBindings>;
export const vaultApi = new Hono<WorkerBindings>();
const now = () => new Date().toISOString();
const db = (c: C) => drizzle(c.env.DB!);
const language = (c: C) => instanceInfo(c.env).language;
const data = (c: C, result: unknown, rowsWritten?: number) =>
  apiJson(c, {
    success: true,
    data: result,
    ...(rowsWritten === undefined ? {} : { meta: { rowsWritten } }),
  });
const conflict = (c: C, message: string) =>
  apiJson(
    c,
    {
      success: false,
      error: { code: "CONFLICT", message },
    },
    409,
  );

for (const route of [
  "/vault/*",
  "/ideas",
  "/ideas/*",
  "/working-papers",
  "/working-papers/*",
  "/suggestions",
  "/suggestions/*",
  "/projects",
  "/projects/*",
])
  vaultApi.use(route, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!c.env.DB) return unavailable("Vault index: DB binding missing");
    await next();
  });

vaultApi.get("/vault/index", async (c) =>
  data(
    c,
    await getVaultIndex(
      db(c),
      c.req.query("titleKeys") === "1",
      c.req.query("titleKeyCount") === "1",
    ),
  ),
);
vaultApi.get("/vault/index/ids", async (c) => {
  const cursor = vaultHash.optional().parse(c.req.query("after")) ?? "";
  const database = db(c);
  const { snapshot } = await getVaultIndex(database);
  const items = await vaultIndexIds(database, cursor, 101);
  if ((await getVaultIndex(database)).snapshot !== snapshot)
    return conflict(
      c,
      "The vault index changed while reading. Run sync again.",
    );
  return data(c, {
    snapshot,
    items: items.slice(0, 100),
    next: items.length > 100 ? items[99]!.id : null,
  });
});
vaultApi.put("/vault/index", async (c) => {
  const input = z
    .union([indexBatch, indexCommit, indexTitleBackfill])
    .parse(c.get("ingestBody"));
  if ("backfillTitleKeys" in input) {
    const { rowsWritten, ...state } = await backfillVaultTitleKeys(db(c));
    return data(c, state, rowsWritten);
  }
  if ("notes" in input) {
    for (const note of input.notes) {
      if (note.id !== (await hashVaultText(note.path)))
        return apiJson(
          c,
          {
            success: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "Note ID must match the path hash.",
            },
          },
          400,
        );
    }
    const { accepted, rowsWritten } = await stageVaultIndex(db(c), input);
    return data(c, { accepted }, rowsWritten);
  }
  const { published, rowsWritten } = await publishVaultIndex(
    db(c),
    input,
    now(),
  );
  return data(c, { published }, rowsWritten);
});
vaultApi.get("/vault/matches", async (c) => {
  const candidates = z
    .array(z.string().max(3300))
    .min(1)
    .max(8)
    .parse(c.req.queries("note"));
  let input: unknown[];
  try {
    input = candidates.map((value) => JSON.parse(value) as unknown);
  } catch {
    return invalidJson(c);
  }
  return data(
    c,
    await lookupVaultMatches(db(c), z.array(vaultMatch).parse(input)),
  );
});
vaultApi.get("/vault/papers", async (c) => {
  const ids = z.array(vaultId).min(1).max(8).parse(c.req.queries("id"));
  return data(c, await readVaultPapers(db(c), ids, language(c)));
});
vaultApi.get("/vault/digests/:day", async (c) =>
  data(
    c,
    await readVaultDigest(
      db(c),
      z.iso.date().parse(c.req.param("day")),
      language(c),
    ),
  ),
);
vaultApi.get("/vault/paper-note/:paperId", async (c) =>
  data(c, await paperVaultNote(db(c), vaultId.parse(c.req.param("paperId")))),
);

vaultApi.get("/vault/info", (c) =>
  data(c, { name: c.env.VAULT_NAME ?? "vault" }),
);
vaultApi.get("/vault/captures", async (c) =>
  data(c, await pendingCaptures(db(c), now())),
);
vaultApi.get("/vault/status", async (c) => {
  let settings: unknown;
  try {
    settings = JSON.parse(c.env.VAULT_CONVENTIONS ?? "null");
  } catch {
    // Older deployments and invalid bindings can still show the last report.
  }
  const conventionSettings = vaultConventionSettings.safeParse(settings).data;
  return data(c, {
    ...(await getVaultStatus(db(c), now())),
    conventionSettings,
  });
});
vaultApi.put("/vault/report", async (c) => {
  const changed = await recordVaultSync(
    db(c),
    syncReport.parse(c.get("ingestBody")),
    now(),
  );
  return data(c, { recorded: true }, changed);
});
vaultApi.get("/vault/requests", async (c) => {
  z.literal("queued").parse(c.req.query("state"));
  return data(c, await queuedVaultRequests(db(c), now(), language(c)));
});
vaultApi.post("/vault/requests", async (c) => {
  const input = newVaultRequest.parse(c.get("ingestBody"));
  try {
    if ("paperId" in input && input.paperId)
      await restoreCompactPaper(c.env, input.paperId);
    const { rowsWritten, ...request } = await createVaultRequest(
      db(c),
      input,
      now(),
      c.get("apiToken") ? "cli" : "web",
    );
    return apiJson(
      c,
      { success: true, data: request, meta: { rowsWritten } },
      201,
    );
  } catch (error) {
    if (error instanceof VaultRequestError) return conflict(c, error.message);
    throw error;
  }
});
vaultApi.patch("/vault/requests/:id", async (c) => {
  const rowsWritten = await editCapture(
    db(c),
    vaultId.parse(c.req.param("id")),
    captureEdit.parse(c.get("ingestBody")),
    now(),
  );
  return rowsWritten
    ? data(c, { edited: true }, rowsWritten)
    : conflict(c, "The capture is unavailable or already being applied.");
});
vaultApi.delete("/vault/requests/:id", async (c) => {
  const id = vaultId.parse(c.req.param("id"));
  if (z.literal("rejected").optional().parse(c.req.query("clear"))) {
    const cleared = await clearRejectedMove(db(c), id);
    return cleared
      ? data(c, { cleared }, 1)
      : conflict(c, "The rejected move is unavailable.");
  }
  const { ended: cancelled, rowsWritten } = await cancelVaultRequest(
    db(c),
    id,
    now(),
  );
  return cancelled
    ? data(c, { cancelled }, rowsWritten)
    : conflict(c, "The request is already being applied or has been resolved.");
});
vaultApi.post("/vault/requests/:id/claim", async (c) => {
  const { claim, resultHash } = vaultClaim.parse(c.get("ingestBody"));
  const id = vaultId.parse(c.req.param("id"));
  const database = db(c);
  const request = await claimVaultRequestKind(
    database,
    id,
    claim,
    now(),
    resultHash,
  );
  const claimed = Boolean(request);
  const capture =
    request?.kind === "capture"
      ? await claimedCapture(database, id, claim)
      : null;
  return data(c, { claimed, ...(capture ? { capture } : {}) }, claimed ? 1 : 0);
});
vaultApi.post("/vault/requests/:id/resolve", async (c) => {
  const resolution = resolveVaultRequest.parse(c.get("ingestBody"));
  const { ended: resolved, rowsWritten } = await resolve(
    db(c),
    vaultId.parse(c.req.param("id")),
    resolution,
    now(),
  );
  return data(c, { resolved }, rowsWritten);
});

const after = (c: C) => vaultHash.optional().parse(c.req.query("after")) ?? "";
vaultApi.get("/ideas", async (c) =>
  data(
    c,
    researchPage(await listVaultIdeas(db(c), after(c), researchPageSize + 1)),
  ),
);
vaultApi.get("/ideas/:id", async (c) =>
  data(c, await vaultIdeaById(db(c), vaultHash.parse(c.req.param("id")))),
);
vaultApi.get("/vault/notes/:id", async (c) =>
  data(c, await vaultNoteById(db(c), vaultHash.parse(c.req.param("id")))),
);
vaultApi.get("/projects", async (c) =>
  data(c, await vaultProjectPage(db(c), after(c))),
);
vaultApi.get("/projects/:id", async (c) =>
  data(
    c,
    (
      await listVaultProjects(db(c), "", 1, vaultHash.parse(c.req.param("id")))
    )[0] ?? null,
  ),
);

vaultApi.get("/working-papers", async (c) =>
  data(
    c,
    researchPage(
      await listWorkingPapers(db(c), after(c), researchPageSize + 1),
    ),
  ),
);
vaultApi.get("/working-papers/:id", async (c) =>
  data(
    c,
    await getWorkingPaper(
      db(c),
      vaultHash.parse(c.req.param("id")),
      userDay(c.env, new Date()),
    ),
  ),
);
vaultApi.get("/suggestions", async (c) =>
  data(
    c,
    researchPage(
      await listSuggestions(
        db(c),
        suggestionsQuery.parse(c.req.query()),
        researchPageSize + 1,
      ),
    ),
  ),
);
vaultApi.post("/suggestions/:id/:action{accept|dismiss}", async (c) => {
  try {
    const { rowsWritten, ...result } = await resolveSuggestion(
      db(c),
      vaultId.parse(c.req.param("id")),
      suggestionAction.parse(c.req.param("action")),
      now(),
      c.get("apiToken") ? "cli" : "web",
      language(c),
    );
    return data(c, result, rowsWritten);
  } catch (error) {
    if (error instanceof VaultRequestError) return conflict(c, error.message);
    throw error;
  }
});
