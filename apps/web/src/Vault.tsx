import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderSync } from "lucide-react";
import { z } from "zod";
import {
  queuedReply,
  type vaultPaperNote,
} from "@litscout/pipeline/vault-contracts";
import {
  useRefreshResearch,
  useVaultPaper,
  useVaultStatus,
} from "./research-api";
import { UnmatchedVaultNote, VaultConventions } from "./VaultConventions";
import { apiMutation } from "./api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { PageHeader } from "./PageHeader";
import { ObsidianLink } from "./ObsidianLink";
import { QueryState } from "./Notice";
import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { countOf, formatCount, formatTimestamp } from "./format";

const kindLabel = {
  capture: "New idea",
  link_paper: "Link a paper",
  set_status: "Change status",
  add_reading: "Add to reading list",
  make_paper_note: "Make a vault note",
};
const ownership = [
  [
    "Only in your vault",
    "Your research notes, plans, Inbox and private documents.",
  ],
  [
    "From your vault, shown here",
    "Project and idea details, working-paper reading lists and paper-note paths.",
  ],
  [
    "From LitScout, copied to your vault",
    "Daily digests, paper summaries, links and quick notes.",
  ],
  [
    "Waiting to go to your vault",
    "Idea captures and requests to create or update a note.",
  ],
];
const countNouns = {
  project: ["project", "projects"],
  idea: ["idea", "ideas"],
  working_paper: ["working paper", "working papers"],
  paper_note: ["paper note", "paper notes"],
  brief: ["brief", "briefs"],
} as const;
const cancelled = z.object({ cancelled: z.literal(true) });

export function VaultSync({ timezone }: { timezone: string }) {
  const refresh = useRefreshResearch();
  const status = useVaultStatus();
  const cancel = useMutation({
    mutationFn: (id: string) =>
      apiMutation(
        "/vault/requests/" + encodeURIComponent(id),
        "DELETE",
        {},
        cancelled,
      ),
    onSuccess: async () => {
      await refresh();
    },
  });
  const data = status.data,
    last = data?.last;
  const needsReview = Boolean(
    data?.rejected.length || last?.handEdited.length || last?.issues.length,
  );
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Vault sync"
        description="Sync runs on your Mac. Requests are applied when the sync has vault writes enabled."
        actions={
          <p className="text-xs text-muted-foreground">
            Run manually with{" "}
            <code className="rounded-sm bg-border/40 px-1.5 py-1 text-subtle">
              litscout sync
            </code>
          </p>
        }
      />
      {last?.writeEnabled === false && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-subtle">
          <span className="rounded-xs bg-control px-2 py-0.5 text-xs text-foreground">
            Preview only
          </span>
          <strong className="font-medium text-foreground">
            Vault writes are off
          </strong>
          <span>
            Sync previews file changes until you enable <code>vault.write</code>{" "}
            on your Mac.
          </span>
        </p>
      )}
      {/* Reference material, closed by default: what stays private. */}
      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          What lives where
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            what stays private, what syncs
          </span>
        </summary>
        <div className="grid gap-3 border-t p-4 sm:grid-cols-2 xl:grid-cols-4">
          {ownership.map(([label, description]) => (
            <article key={label}>
              <h3 className="text-xs font-semibold text-subtle">{label}</h3>
              <p className="mt-1 text-sm text-subtle">{description}</p>
            </article>
          ))}
        </div>
      </details>
      {(status.isPending || status.isError) && (
        <QueryState
          query={status}
          label="Loading vault status…"
          errorTitle="Vault status is unavailable."
        />
      )}
      {data && (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
          <section className="reader-panel" aria-labelledby="vault-waiting">
            <header className="flex flex-wrap justify-between gap-2">
              <h2 id="vault-waiting" className="reader-section-title">
                Waiting for sync
              </h2>
              <span className="text-sm text-subtle">
                {formatCount(data.queuedCount)}{" "}
                {data.queuedCount === 1 ? "request" : "requests"}
              </span>
            </header>
            {data.queued.length ? (
              <ul className="reader-list mt-3 divide-y">
                {data.queued.map((request) => (
                  <li
                    key={request.id}
                    className="reader-row flex flex-wrap items-center justify-between gap-2"
                  >
                    <div className="grid min-w-0 flex-1 items-baseline gap-1 xl:grid-cols-[8rem_minmax(0,1fr)] xl:gap-x-3">
                      <Badge variant="outline" className="text-subtle">
                        {kindLabel[request.kind]}
                      </Badge>
                      <p className="text-sm font-medium break-words">
                        {request.title}
                      </p>
                      {request.path && (
                        <p className="text-xs break-all text-subtle xl:col-start-2">
                          {request.path}
                        </p>
                      )}
                    </div>
                    {request.applying ? (
                      <span className="text-xs text-subtle">Applying…</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancel.isPending}
                        aria-label={"Cancel " + request.title}
                        onClick={() => cancel.mutate(request.id)}
                      >
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-3">
                <EmptyState compact title="No requests waiting." />
              </div>
            )}
            {data.queuedCount > data.queued.length && (
              <p className="text-xs text-subtle">
                Showing the oldest {countOf(data.queued.length, "request")}.
              </p>
            )}
            {cancel.isError && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {cancel.error.message}
              </p>
            )}
          </section>
          <div className="grid gap-4">
            <section className="reader-panel" aria-labelledby="vault-last">
              <h2 id="vault-last" className="reader-section-title">
                Last sync
              </h2>
              {last ? (
                <>
                  <time
                    className="mt-1 block text-sm text-subtle"
                    dateTime={last.at}
                  >
                    {formatTimestamp(last.at, timezone)}
                  </time>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {Object.entries(last.counts).map(([kind, count]) => (
                      <li key={kind}>
                        <Badge variant="secondary">
                          {formatCount(count)}{" "}
                          {
                            countNouns[kind as keyof typeof countNouns][
                              count === 1 ? 0 : 1
                            ]
                          }
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {last.conventions === undefined &&
                    last.excludedFolders !== undefined &&
                    last.excludedNotes !== undefined && (
                      <p className="mt-2 text-xs text-subtle">
                        <span>
                          {formatCount(last.excludedFolders)} excluded{" "}
                          {last.excludedFolders === 1 ? "folder" : "folders"}
                        </span>
                        {" · "}
                        <span>
                          {formatCount(last.excludedNotes)} excluded{" "}
                          {last.excludedNotes === 1 ? "note" : "notes"}
                        </span>
                      </p>
                    )}
                  {last.writes.length ? (
                    <details className="mt-3 text-sm">
                      <summary className="cursor-pointer">
                        {formatCount(last.writes.length)}{" "}
                        {last.writeEnabled ? "updates" : "planned writes"}
                      </summary>
                      <ul className="mt-2 space-y-1 break-all text-subtle">
                        {last.writes.map(({ kind, path }, index) => (
                          <li key={kind + ":" + path + ":" + index}>{path}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <div className="mt-3">
                      <EmptyState compact title="No file updates." />
                    </div>
                  )}
                </>
              ) : (
                <div className="mt-3">
                  <EmptyState
                    compact
                    title="No sync has been recorded."
                    description={
                      <>
                        Run <code>litscout sync --dry-run</code> on your Mac and
                        read the results in your terminal. Run{" "}
                        <code>litscout sync</code> to publish the report here.
                      </>
                    }
                  />
                </div>
              )}
            </section>
            <VaultConventions status={data} />
            {needsReview && (
              <section
                className="reader-panel border-radar-border bg-radar-soft"
                aria-labelledby="vault-review"
              >
                <h2
                  id="vault-review"
                  className="reader-section-title text-radar"
                >
                  Needs review
                </h2>
                <ul className="reader-list mt-3 divide-y text-sm break-words">
                  {data.rejected.map((request) => (
                    <li className="reader-row" key={request.id}>
                      <strong>{request.title}</strong>
                      <p className="text-subtle">{request.reason}</p>
                    </li>
                  ))}
                  {last?.handEdited.map((path) => (
                    <li className="reader-row" key={path}>
                      <strong>Hand-edited block kept</strong>
                      <p className="break-all text-subtle">{path}</p>
                    </li>
                  ))}
                  {last?.issues.map(({ path, reason }, index) => (
                    <li className="reader-row" key={path + ":" + index}>
                      <strong className="break-all">{path}</strong>
                      <p className="text-subtle">{reason}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export function VaultPaperPanel({ paperId }: { paperId: string }) {
  const heading = useId(),
    client = useQueryClient();
  const key = ["vault", "paper-note", paperId];
  const note = useVaultPaper(paperId);
  const announce = usePageAnnouncement();
  const request = useMutation({
    mutationFn: () =>
      apiMutation(
        "/vault/requests",
        "POST",
        { kind: "make_paper_note", paperId },
        queuedReply,
      ),
    onSuccess: () => {
      client.setQueryData<z.output<typeof vaultPaperNote>>(key, (previous) => ({
        ...previous,
        path: null,
        pending: true,
      }));
      announce?.("Vault note requested.");
      return client.invalidateQueries({ queryKey: ["vault"] });
    },
  });
  return (
    <section aria-labelledby={heading} className="reader-panel bg-accent">
      <h2
        id={heading}
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <FileText aria-hidden="true" className="size-4" />
        In your vault
      </h2>
      {note.isPending && (
        <div className="mt-2">
          <LoadingState compact label="Checking for a note…" />
        </div>
      )}
      {note.isError && (
        <div className="mt-2">
          <EmptyState
            compact
            role="alert"
            title="Vault note status is unavailable."
          />
        </div>
      )}
      {note.data?.path && (
        <>
          <p className="mt-2 text-sm break-all">{note.data.path}</p>
          <ObsidianLink path={note.data.path}>Open in Obsidian</ObsidianLink>
          {note.data.matchedBy === "title" && (
            <p className="mt-1 text-xs text-subtle">Matched by title</p>
          )}
        </>
      )}
      {note.data && !note.data.path && (
        <UnmatchedVaultNote count={note.data.notesWithoutIdentifiers} />
      )}
      {note.data &&
        !note.data.path &&
        (note.data.pending ? (
          <p
            role={announce ? undefined : "status"}
            className="mt-2 text-sm text-subtle"
          >
            Vault note requested.
          </p>
        ) : (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            disabled={request.isPending}
            onClick={() => request.mutate()}
          >
            <FolderSync data-icon="inline-start" /> Make a vault note
          </Button>
        ))}
      {request.isError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {request.error.message}
        </p>
      )}
    </section>
  );
}
