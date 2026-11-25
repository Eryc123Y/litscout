import { useId, type ReactNode } from "react";
import type { z } from "zod";
import type { vaultStatus } from "@litscout/pipeline/vault-contracts";
import { useVaultStatus } from "./research-api";
import { EmptyState } from "./ReaderState";
import { formatCount } from "./format";

type Status = z.output<typeof vaultStatus>;
type TagField = "ideaTag" | "workingPaperTag";
const defaults = {
  ideaTag: "type/idea",
  workingPaperTag: "type/working-paper",
} as const;

function tag(field: TagField, status?: Status) {
  return (
    status?.last?.conventions?.[field] ??
    status?.conventionSettings?.[field] ??
    defaults[field]
  );
}

/** The instance's guide (config vault.guideUrl), else where the guide is. */
function VaultGuideLink() {
  const guideUrl = useVaultStatus().data?.conventionSettings?.guideUrl;
  return guideUrl ? (
    <a
      className="text-sm text-primary underline underline-offset-4"
      href={guideUrl}
    >
      Vault conventions guide
    </a>
  ) : (
    <span className="text-sm text-muted-foreground">
      Vault conventions in docs/self-host.md
    </span>
  );
}

export function VaultTagEmptyState({
  field,
  children,
}: {
  field: TagField;
  children?: ReactNode;
}) {
  const status = useVaultStatus();
  const idea = field === "ideaTag";
  return (
    <div className="reader-panel">
      <EmptyState
        compact
        title={
          idea ? "No ideas indexed yet." : "No working papers indexed yet."
        }
        description={
          <p>
            LitScout shows notes tagged <code>{tag(field, status.data)}</code>{" "}
            (from <code>vault.{field}</code>). Tag{" "}
            {idea ? "an idea" : "a working paper"} note in Obsidian and run{" "}
            <code>litscout sync</code>
            {idea ? ", or capture one here." : "."}
            {idea &&
              " Ideas marked seed or exploring also go to the morning digest, which suggests papers and combinations for them."}
          </p>
        }
        actions={
          <>
            {children}
            <VaultGuideLink />
          </>
        }
      />
    </div>
  );
}

export function ProjectsEmptyState() {
  const { data } = useVaultStatus();
  const projects = data?.conventionSettings?.projects;
  return (
    <div className="reader-panel">
      <EmptyState
        compact
        title="No projects indexed yet."
        description={
          <div className="space-y-2">
            <p>
              LitScout shows notes whose paths match <code>vault.projects</code>
              .
            </p>
            {projects?.length ? (
              <ul className="list-disc space-y-1 pl-5 break-words">
                {projects.map((pattern) => (
                  <li key={pattern}>
                    <code>{pattern}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            <p>
              Add a project note under a matching path, or add its path pattern
              to your config, then run <code>litscout sync</code>.
            </p>
          </div>
        }
        actions={<VaultGuideLink />}
      />
    </div>
  );
}

export function VaultConventions({ status }: { status: Status }) {
  const heading = useId();
  const report = status.last?.conventions;
  const papers = report?.paperNotesWithoutIdentifiers;
  const excludedFolders =
    report?.excludedFolders ?? status.last?.excludedFolders;
  return (
    <section className="reader-panel" aria-labelledby={heading}>
      <h2 id={heading} className="reader-section-title">
        Vault conventions
      </h2>
      <dl className="mt-2 space-y-2 text-sm text-subtle">
        <div>
          <dt className="font-medium">Idea tag</dt>
          <dd>
            <code>{tag("ideaTag", status)}</code>
            {report
              ? " · " + formatCount(report.ideaNotes) + " tagged notes"
              : ""}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Working paper tag</dt>
          <dd>
            <code>{tag("workingPaperTag", status)}</code>
            {report
              ? " · " + formatCount(report.workingPaperNotes) + " tagged notes"
              : ""}
          </dd>
        </div>
      </dl>
      {report && papers ? (
        <div className="mt-3 space-y-2 text-sm text-subtle">
          <p>
            {formatCount(papers.count)} paper{" "}
            {papers.count === 1 ? "note" : "notes"} without <code>arxiv</code>{" "}
            or <code>doi</code>
            {papers.paths.length < papers.count
              ? ` (showing ${formatCount(papers.paths.length)} of ${formatCount(papers.count)})`
              : ""}
          </p>
          {papers.paths.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 break-words">
              {papers.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
          <p>
            <span>
              {formatCount(report.possibleNonProjects)} possible non-projects
            </span>
            {" · Review notes matched by "}
            <code>vault.projects</code>.
          </p>
          {excludedFolders !== undefined && (
            <p>
              {formatCount(excludedFolders)} excluded{" "}
              {excludedFolders === 1 ? "folder" : "folders"}
            </p>
          )}
          <p>
            {formatCount(report.excludedNotes)} excluded{" "}
            {report.excludedNotes === 1 ? "note" : "notes"}
          </p>
          <p>
            {formatCount(report.privateNotes)} private{" "}
            {report.privateNotes === 1 ? "note" : "notes"}
          </p>
          {report.templates && report.templates.count > 0 && (
            <>
              <p>
                {formatCount(report.templates.count)} template{" "}
                {report.templates.count === 1 ? "note" : "notes"} skipped
                (frontmatter has <code>{"{{…}}"}</code> or{" "}
                <code>{"<% … %>"}</code> placeholders)
              </p>
              <ul className="list-disc space-y-1 pl-5 break-words">
                {report.templates.paths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : status.last ? (
        <p className="mt-3 text-sm text-subtle">
          Run <code>litscout sync</code> to publish convention counts.
        </p>
      ) : null}
      <p className="mt-3">
        <VaultGuideLink />
      </p>
    </section>
  );
}

export function UnmatchedVaultNote({ count }: { count?: number }) {
  return (
    <div className="mt-2">
      <EmptyState
        compact
        title="No matching vault note."
        description={
          <div className="space-y-1">
            {count === undefined ? (
              <p>
                Run <code>litscout sync</code> to check for paper notes without
                identifiers.
              </p>
            ) : (
              <p>
                {formatCount(count)} paper {count === 1 ? "note" : "notes"}{" "}
                without identifiers in the last sync.
                {count > 0 ? " One could be this paper." : ""}
              </p>
            )}
            <p>
              If you have a note for this paper, add its <code>arxiv</code> or{" "}
              <code>doi</code> in Obsidian and run <code>litscout sync</code>.
            </p>
          </div>
        }
      />
    </div>
  );
}
