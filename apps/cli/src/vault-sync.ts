import { z } from "zod";
import { shiftDay } from "@litscout/pipeline/day-gaps";
import { chunks, type FeedApi } from "@litscout/pipeline/api";
import {
  indexBatchSize,
  indexHead,
  titleKeyCountCap,
  indexIds,
  indexTitleBackfillReply,
  queuedVaultRequest,
  vaultClaimReply,
  syncReport,
  vaultDigest,
  vaultKinds,
  vaultMatchResult,
  vaultPaper,
  vaultPath,
  vaultWriteReservation,
  type indexCommit,
  type syncStage,
  type SyncReport,
  type VaultNote,
} from "@litscout/pipeline/vault-contracts";
import {
  openVault,
  localVaultSource,
  type VaultConfig,
} from "@litscout/sync/vault-source";
import { localVaultSink, type VaultWrite } from "@litscout/sync/vault-sink";
import {
  editStatus,
  hash,
  HandEdited,
  VaultError,
} from "@litscout/sync/vault-note";

type Stage = z.output<typeof syncStage>;
type Options = {
  day: string;
  only?: Stage;
  dryRun?: boolean;
  adopt?: boolean;
  skipRequests?: boolean;
  onWrite?: (write: SyncReport["writes"][number]) => void;
};
type Rejection = { id: string; reason: string; mode: "planned" | "rejected" };

// Measured on staging (2026-11-19): 12,441 rows for 6,072 keys (3,036 papers
// and their compact rows, which the count includes separately).
const rowsPerTitleKey = 2;

/** What the first index upload will spend keying titles; null when unknown. */
async function titleKeyEstimate(api: FeedApi) {
  try {
    const head = indexHead.parse(
      await api.get("/vault/index?titleKeys=1&titleKeyCount=1"),
    );
    const pending = head.titleKeysPendingCount;
    return pending === undefined
      ? null
      : {
          pending,
          estimatedRows: pending * rowsPerTitleKey,
          // Each table is counted up to the cap, so a large backlog is a floor.
          capped: pending >= titleKeyCountCap,
        };
  } catch {
    return null;
  }
}

async function prepareIndex(api: FeedApi) {
  const current = indexHead.parse(await api.get("/vault/index?titleKeys=1"));
  const backfill = { backfillTitleKeys: true };
  let pending = current.titleKeysPending;
  while (pending) {
    ({ titleKeysPending: pending } = indexTitleBackfillReply.parse(
      await api.write(
        "/vault/index",
        backfill,
        vaultWriteReservation("/vault/index", backfill),
        "PUT",
      ),
    ));
  }
  return current;
}

async function publishIndex(
  api: FeedApi,
  finish: z.output<typeof indexCommit>,
) {
  const { published } = z
    .object({ published: z.boolean() })
    .parse(
      await api.write(
        "/vault/index",
        finish,
        vaultWriteReservation("/vault/index", finish),
        "PUT",
      ),
    );
  if (!published)
    throw new VaultError("The index was not published. Run sync again.");
}

async function uploadIndex(
  api: FeedApi,
  notes: VaultNote[],
  current: z.output<typeof indexHead>,
) {
  const snapshot = hash(JSON.stringify(notes));
  if (current.snapshot === snapshot) {
    await publishIndex(api, {
      snapshot,
      previous: snapshot,
      parts: 1,
      count: notes.length,
      changes: 0,
    });
    return "unchanged";
  }
  const fingerprints = new Map<string, string>();
  if (current.count) {
    let after: string | null = null;
    do {
      const page = indexIds.parse(
        await api.get("/vault/index/ids" + (after ? "?after=" + after : "")),
      );
      if (page.snapshot !== current.snapshot)
        throw new VaultError(
          "The vault index changed while reading. Run sync again.",
        );
      for (const item of page.items)
        fingerprints.set(item.id, item.fingerprint);
      after = page.next;
    } while (after);
    if (fingerprints.size !== current.count)
      throw new VaultError(
        "The vault index changed while reading. Run sync again.",
      );
  }
  const changed = notes.filter((note) => {
    const previous = fingerprints.get(note.id);
    fingerprints.delete(note.id);
    return hash(JSON.stringify(note)) !== previous;
  });
  const removed = [...fingerprints.keys()];
  const run = { snapshot, previous: current.snapshot };
  const updates = indexParts(changed),
    deletions = chunks(removed, indexBatchSize);
  const parts = Math.max(1, updates.length, deletions.length);
  for (let part = 0; part < parts; part++) {
    const reply = z.object({ accepted: z.boolean() }).parse(
      await api.write(
        "/vault/index",
        {
          ...run,
          part,
          notes: updates[part] ?? [],
          removed: deletions[part] ?? [],
        },
        4,
        "PUT",
      ),
    );
    if (!reply.accepted)
      throw new VaultError("Another index upload started. Run sync again.");
  }
  await publishIndex(api, {
    ...run,
    parts,
    count: notes.length,
    changes: changed.length + removed.length,
  });
  return "uploaded";
}

function shortReason(error: unknown) {
  return error instanceof VaultError
    ? error.message
    : "Could not safely update the vault file.";
}

export async function syncVault(
  config: VaultConfig,
  configDir: string,
  api: FeedApi,
  options: Options,
) {
  const { only, dryRun = false, day, adopt } = options;
  const includes = (stage: Stage) =>
    (only === undefined || only === stage) &&
    !(stage === "requests" && options.skipRequests);
  const canWrite = config.write && !dryRun;
  const vault = await openVault(config, configDir);
  const source = localVaultSource(vault, config);
  const result: SyncReport = {
    writeEnabled: config.write,
    counts: { project: 0, idea: 0, working_paper: 0, paper_note: 0, brief: 0 },
    writes: [],
    handEdited: [],
    issues: [],
  };
  const rejected: Rejection[] = [];
  const applied: string[] = [];
  const scanOptions = { conventionsOnly: only === "digests" };
  let scan = await source.index(scanOptions);
  let { notes } = scan;
  const sink = localVaultSink(vault, config, {
    dryRun,
    configDir,
    indexedNotes: notes,
  });
  const indexed = new Map(notes.map((note) => [note.id, note]));
  let index: "uploaded" | "unchanged" | "planned" | "skipped" = includes(
    "index",
  )
    ? "planned"
    : "skipped";
  const titleKeys =
    dryRun && includes("index") ? await titleKeyEstimate(api) : null;
  const currentIndex =
    !dryRun && includes("index") ? await prepareIndex(api) : null;
  // An index-only or read-only sync can publish even if a later preview fails.
  if (currentIndex && (!canWrite || only === "index"))
    index = await uploadIndex(api, notes, currentIndex);

  function record(
    kind: SyncReport["writes"][number]["kind"],
    write: VaultWrite,
  ) {
    if (write.changed) {
      const item = {
        kind,
        path: write.path,
        mode: canWrite ? ("applied" as const) : ("planned" as const),
      };
      result.writes.push(item);
      options.onWrite?.(item);
    }
  }
  function issue(file: string, error: unknown) {
    if (error instanceof HandEdited && !result.handEdited.includes(file))
      result.handEdited.push(file);
    else if (!(error instanceof HandEdited))
      result.issues.push({ path: file, reason: shortReason(error) });
  }

  if (includes("requests")) {
    const requests = z
      .array(queuedVaultRequest)
      .parse(await api.get("/vault/requests?state=queued"));
    for (const queued of requests) {
      let request = queued;
      const route = "/vault/requests/" + request.id;
      const claim = canWrite ? crypto.randomUUID() : undefined;
      const target =
        "target" in request ? indexed.get(request.target.id) : undefined;
      const targetMatches =
        !("target" in request) ||
        (target?.kind ===
          (request.kind === "add_reading" ? "working_paper" : "idea") &&
          target.path === request.target.path);
      // A retry can recognize an applied edit if the acknowledgement was lost.
      let resultHash: string | undefined;
      if (
        claim &&
        targetMatches &&
        request.kind === "set_status" &&
        !request.resultHash
      ) {
        try {
          const text = await vault.read(request.target.path);
          if (text !== null && hash(text) === request.baseHash)
            resultHash = hash(editStatus(text, request.status));
        } catch {
          // The sink checks the target again and reports a safe rejection reason.
        }
      }
      if (claim) {
        const reply = vaultClaimReply.parse(
          await api.write(route + "/claim", { claim, resultHash }, 12),
        );
        if (!reply.claimed) continue;
        if (request.kind === "capture" && reply.capture)
          request = { ...request, ...reply.capture };
      }

      let reason: string | undefined;
      try {
        if (!targetMatches)
          throw new VaultError(
            "The target note is missing, excluded or no longer has the expected tag.",
          );
        record(request.kind, await sink.request(request));
      } catch (error) {
        if ("target" in request && targetMatches)
          issue(request.target.path, error);
        else if (request.kind === "capture")
          issue(vaultPath.parse(config.inbox), error);
        reason = shortReason(error);
        rejected.push({
          id: request.id,
          reason,
          mode: canWrite ? "rejected" : "planned",
        });
      }
      if (canWrite) {
        const resolution = reason
          ? { state: "rejected", reason, claim }
          : { state: "applied", claim };
        const reply = z
          .object({ resolved: z.boolean() })
          .parse(await api.write(route + "/resolve", resolution, 12));
        if (!reply.resolved)
          throw new VaultError(
            "A vault request could not be resolved. Run sync again.",
          );
        if (!reason) applied.push(request.id);
      }
    }
  }

  if (includes("blocks")) {
    const candidates = notes.flatMap((note) =>
      note.kind === "paper_note"
        ? [
            {
              id: note.id,
              ...(note.frontmatter.arxiv || note.frontmatter.doi
                ? { arxiv: note.frontmatter.arxiv, doi: note.frontmatter.doi }
                : { title: note.title }),
            },
          ]
        : [],
    );
    const queries: URLSearchParams[] = [];
    let query = new URLSearchParams();
    for (const candidate of candidates) {
      const encoded = JSON.stringify(candidate);
      // Leave room for the URL prefix when percent-encoded titles are long.
      if (
        query.size === 8 ||
        query.toString().length +
          new URLSearchParams({ note: encoded }).toString().length >
          12_000
      ) {
        queries.push(query);
        query = new URLSearchParams();
      }
      query.append("note", encoded);
    }
    if (query.size) queries.push(query);
    for (const query of queries) {
      const matches = z
        .array(vaultMatchResult)
        .parse(await api.get("/vault/matches?" + query));
      if (!matches.length) continue;
      const parameters = new URLSearchParams(
        [...new Set(matches.map((match) => match.paperId))].map((id) => [
          "id",
          id,
        ]),
      );
      const papers = z
        .array(vaultPaper)
        .parse(await api.get("/vault/papers?" + parameters));
      const byId = new Map(papers.map((paper) => [paper.id, paper]));
      for (const match of matches) {
        const paper = byId.get(match.paperId),
          target = indexed.get(match.id);
        if (!paper || !target) continue;
        try {
          record("block", await sink.block(target.path, paper));
        } catch (error) {
          issue(target.path, error);
        }
      }
    }
  }

  if (includes("digests")) {
    const digest = vaultDigest
      .nullable()
      .parse(await api.get("/vault/digests/" + day));
    if (digest) {
      const destination = vaultPath.parse(
        config.digestsDir.replace(/\/+$/, "") + "/" + day + ".md",
      );
      try {
        record("digest", await sink.digest(day, digest.markdown, adopt));
      } catch (error) {
        issue(destination, error);
      }
    }
    // Digests written late, or on a day this machine did not sync: the six
    // days before, where the file is missing. An existing file stays as it is.
    for (let back = 1; back <= 6; back++) {
      const earlier = shiftDay(day, -back);
      const file = vaultPath.parse(
        config.digestsDir.replace(/\/+$/, "") + "/" + earlier + ".md",
      );
      let late: z.output<typeof vaultDigest> | null;
      try {
        if ((await vault.read(file)) !== null) continue;
        late = vaultDigest
          .nullable()
          .parse(await api.get("/vault/digests/" + earlier));
      } catch {
        // Catching up is best effort; the next sync tries again.
        continue;
      }
      if (!late) continue;
      try {
        record("digest", await sink.digest(earlier, late.markdown, adopt));
      } catch (error) {
        issue(file, error);
      }
    }
  }

  if (canWrite && result.writes.length) scan = await source.index(scanOptions);
  notes = scan.notes;
  result.issues.push(...scan.issues);
  result.excludedFolders = scan.excludedFolders;
  result.excludedNotes = scan.excludedNotes;
  const { conventions } = scan;
  if (currentIndex && index === "planned")
    index = await uploadIndex(api, notes, currentIndex);
  for (const note of notes) result.counts[note.kind]++;
  if (!dryRun)
    z.object({ recorded: z.literal(true) }).parse(
      await api.write(
        "/vault/report",
        syncReport.parse({
          ...result,
          conventions,
          issues: result.issues.slice(0, 1200),
        }),
        4,
        "PUT",
      ),
    );
  const summary = [
    dryRun ? "Dry-run" : config.write ? "Vault writes on" : "Vault writes off",
    "index " +
      index +
      " (" +
      vaultKinds
        .map((kind) => result.counts[kind] + " " + kind.replace("_", " "))
        .join(", ") +
      ")",
    `${scan.excludedFolders} excluded ${scan.excludedFolders === 1 ? "folder" : "folders"}`,
    `${scan.excludedNotes} excluded ${scan.excludedNotes === 1 ? "note" : "notes"}`,
    result.writes.length + (canWrite ? " files updated" : " planned writes"),
    rejected.length +
      (canWrite ? " rejected requests" : " requests would be rejected"),
    result.handEdited.length + " hand-edited blocks",
    result.issues.length + " file issues",
    ...(titleKeys && titleKeys.pending > 0
      ? [
          `${titleKeys.capped ? "at least " : ""}${titleKeys.pending} title keys to fill first (about ${titleKeys.estimatedRows} rows)`,
        ]
      : []),
    "Conventions (" +
      [
        tagSummary(
          "ideas",
          conventions.ideaTag,
          conventions.ideaNotes,
          scan.tagCounts?.idea,
        ),
        tagSummary(
          "working papers",
          conventions.workingPaperTag,
          conventions.workingPaperNotes,
          scan.tagCounts?.workingPaper,
        ),
        conventions.paperNotesWithoutIdentifiers.count +
          " paper notes without arxiv or doi",
        conventions.possibleNonProjects +
          " possible non-projects (review vault.projects)",
        conventions.privateNotes + " private",
        (conventions.templates?.count ?? 0) + " templates skipped",
      ].join(", ") +
      ")",
  ].join(" · ");
  return {
    ...result,
    conventions,
    tagCounts: scan.tagCounts,
    dryRun,
    index,
    titleKeys,
    only: only ?? null,
    rejected,
    applied,
    summary,
  };
}

/** One tag reads as before; a list names each tag's matches. */
function tagSummary(
  kind: string,
  label: string,
  total: number,
  counts: Record<string, number> | undefined,
) {
  const entries = Object.entries(counts ?? {});
  return entries.length > 1
    ? kind +
        ": " +
        total +
        " (" +
        entries.map(([tag, n]) => tag + " " + n).join(", ") +
        ")"
    : label + ": " + total;
}

/** Bytes one index part may carry, well below the Worker's 1 MB cap for vault requests. */
const indexPartBytes = 400_000;
/**
 * Index notes in parts of at most `indexBatchSize` notes and about 400 KB.
 * Note bodies (vault.uploadBodies) can be tens of kilobytes each; a single
 * note larger than the cap travels alone.
 */
export function indexParts<T>(notes: readonly T[]): T[][] {
  const encoder = new TextEncoder();
  const parts: T[][] = [];
  let current: T[] = [];
  let size = 2;
  for (const note of notes) {
    const bytes = encoder.encode(JSON.stringify(note)).byteLength + 1;
    if (
      current.length &&
      (current.length >= indexBatchSize || size + bytes > indexPartBytes)
    ) {
      parts.push(current);
      current = [];
      size = 2;
    }
    current.push(note);
    size += bytes;
  }
  if (current.length) parts.push(current);
  return parts;
}
