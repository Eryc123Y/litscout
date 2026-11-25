import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { z } from "zod";
import type { vaultProject } from "@litscout/pipeline/vault-contracts";
import { useInstance, usePaper } from "./api";
import { Button } from "./components/ui/button";
import { Paper } from "./Paper";
import { QueryState } from "./Notice";
import { EmptyState } from "./ReaderState";
import { ObsidianLink } from "./ObsidianLink";
import { NoteBody, useVaultNote } from "./VaultNote";
import { MathText } from "./math-text";
import { formatDay } from "./format";
import { panelValue, type PanelTarget } from "./origin";
import { cn } from "./lib/utils";

export type Project = z.output<typeof vaultProject>;
const tabs = ["radar", "papers", "ideas", "note"] as const;
export type Tab = (typeof tabs)[number];
export const readTab = (value: string | null): Tab | null =>
  tabs.find((tab) => tab === value) ?? null;

/** The current query with some keys set or removed. */
export function searchWith(
  search: URLSearchParams,
  changes: Record<string, string | null>,
) {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes))
    if (value === null) next.delete(key);
    else next.set(key, value);
  const query = next.toString();
  return query ? `?${query}` : "";
}

export function StatusDot({ status }: { status: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "active" ? "bg-good" : "bg-muted-foreground/60",
      )}
    />
  );
}

const levels: Record<string, { name: string; className: string }> = {
  high: { name: "High", className: "bg-radar text-on-radar" },
  medium: { name: "Medium", className: "bg-radar-mid text-on-radar-mid" },
  borrow: { name: "Borrow", className: "bg-radar-low text-on-radar-low" },
};
function Level({ level }: { level: string }) {
  const known = levels[level];
  return (
    <span
      className={cn(
        "rounded-full px-2 text-xs leading-5 font-medium",
        known?.className ?? "bg-control text-subtle",
      )}
    >
      {known?.name ?? level}
    </span>
  );
}

/** A link that reads a paper or an idea note in the project's own column. */
function OpenLink({
  target,
  className,
  children,
}: {
  target: PanelTarget;
  className?: string;
  children: ReactNode;
}) {
  const [search] = useSearchParams();
  return (
    <Link
      to={{ search: searchWith(search, { open: panelValue(target) }) }}
      className={className ?? "reader-record-link"}
    >
      {children}
    </Link>
  );
}

const projectSections = (project: Project): [Tab, string, number | null][] => [
  ["radar", "Radar", project.radar.length],
  ["papers", "Papers", project.papers.length],
  ["ideas", "Ideas", project.ideas.length],
  ["note", "Note", null],
];

/** A project opens on its first list with anything in it; a quiet one on
 * Radar, which says why it is empty. */
export const firstTab = (project: Project): Tab =>
  projectSections(project).find(([, , count]) => count)?.[0] ?? "radar";

export function ProjectDetail({
  project,
  tab,
  open,
  close: back,
}: {
  project: Project;
  tab: Tab;
  open: PanelTarget | null;
  /** Puts an open paper or idea away. */
  close: () => void;
}) {
  const [search] = useSearchParams();
  const backLabel = "Back to " + project.title;
  if (open?.kind === "paper")
    return (
      <ProjectPaper
        id={open.id}
        source={open.source}
        close={back}
        closeLabel={backLabel}
      />
    );
  if (open?.kind === "note")
    return <IdeaNote id={open.id} close={back} closeLabel={backLabel} />;
  const sections = projectSections(project);
  const first = firstTab(project);
  return (
    <article className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-serif text-2xl font-semibold">{project.title}</h2>
          <span className="inline-flex items-center gap-1.5 text-sm text-subtle">
            <StatusDot status={project.status} />
            {project.status}
          </span>
          <span className="ms-auto">
            <ObsidianLink path={project.path} title={project.path}>
              Open in Obsidian
            </ObsidianLink>
          </span>
        </div>
        {project.summary && (
          <p className="max-w-[72ch] text-sm text-subtle">{project.summary}</p>
        )}
      </header>
      <nav
        aria-label="Project sections"
        className="flex flex-wrap gap-1 border-b border-border"
      >
        {sections.map(([key, label, count]) => (
          <Link
            key={key}
            to={{
              search: searchWith(search, { tab: key === first ? null : key }),
            }}
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === key
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {count === null ? null : (
              <>
                {" "}
                <span className="font-normal text-muted-foreground tabular-nums">
                  {count}
                </span>
              </>
            )}
          </Link>
        ))}
      </nav>
      {tab === "radar" && <Radar project={project} />}
      {tab === "papers" && <Papers project={project} />}
      {tab === "ideas" && <Ideas project={project} />}
      {tab === "note" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Read-only. Edit the note in Obsidian.
          </p>
          <div className="note-reading">
            <NoteBody id={project.id} />
          </div>
        </div>
      )}
    </article>
  );
}

function Radar({ project }: { project: Project }) {
  if (!project.radar.length)
    return (
      <EmptyState
        compact
        title="No radar hits in the last 90 days."
        description="Each day the radar grades new papers against this project's note."
      />
    );
  const days = [...new Set(project.radar.map((hit) => hit.day))]
    .sort()
    .reverse();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        High and medium hits were graded from the full text. Borrow marks an
        idea worth borrowing, often judged from the abstract.
      </p>
      {days.map((day) => (
        <section key={day} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-subtle">
            <time dateTime={day}>{formatDay(day)}</time>
          </h3>
          <ul className="reader-list divide-y">
            {project.radar
              .filter((hit) => hit.day === day)
              .map((hit) => (
                <li className="reader-row flex flex-col gap-1" key={hit.id}>
                  <OpenLink target={{ kind: "paper", id: hit.paperId }}>
                    <MathText text={hit.title} />
                  </OpenLink>
                  <div>
                    <Level level={hit.level} />
                  </div>
                  <p className="text-sm text-subtle">{hit.reason}</p>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Papers({ project }: { project: Project }) {
  if (!project.papers.length)
    return (
      <EmptyState
        compact
        title="No linked papers."
        description="Papers listed on this project's ideas or working papers appear here."
      />
    );
  return (
    <ul className="reader-list divide-y">
      {project.papers.map((paper) => (
        <li className="reader-row" key={paper.id}>
          <OpenLink target={{ kind: "paper", id: paper.id }}>
            <MathText text={paper.title} />
          </OpenLink>
        </li>
      ))}
    </ul>
  );
}

function Ideas({ project }: { project: Project }) {
  if (!project.ideas.length)
    return (
      <EmptyState
        compact
        title="No ideas for this project."
        description="Idea notes that name this project appear here."
      />
    );
  return (
    <ul className="reader-list divide-y">
      {project.ideas.map((idea) => (
        <li className="reader-row" key={idea.id}>
          <OpenLink target={{ kind: "note", id: idea.id }}>
            {idea.title}
          </OpenLink>
        </li>
      ))}
    </ul>
  );
}

/** The column's own way back; on a phone the reading bar has it. */
function BackButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <div className="hidden md:block">
      <Button variant="ghost" onClick={onClick}>
        <ArrowLeft data-icon="inline-start" />
        {children}
      </Button>
    </div>
  );
}

function ProjectPaper({
  id,
  source,
  close,
  closeLabel,
}: {
  id: string;
  source?: string;
  close: () => void;
  closeLabel: string;
}) {
  const paper = usePaper(id, undefined, false, source);
  const instance = useInstance();
  if (paper.isPending || paper.isError || instance.isPending || !paper.data)
    return (
      <div className="flex flex-col gap-3">
        <BackButton onClick={close}>{closeLabel}</BackButton>
        {paper.data === null ? (
          <EmptyState compact title="This paper is no longer in LitScout." />
        ) : (
          <QueryState
            query={paper.isError ? paper : instance}
            label="Paper loading…"
            errorTitle="Paper unavailable"
            retryLabel="Retry paper"
          />
        )}
      </div>
    );
  const info = instance.data;
  return (
    <Paper
      paper={paper.data}
      privateActions
      language={info?.language ?? "en"}
      timezone={info?.timezone ?? "UTC"}
      topics={info?.topics ?? []}
      keywordOnly={info?.keywordOnly === true}
      fullHref={`/app/papers/${encodeURIComponent(id)}${source ? `?${new URLSearchParams({ source })}` : ""}`}
      close={close}
      closeLabel={closeLabel}
    />
  );
}

function IdeaNote({
  id,
  close,
  closeLabel,
}: {
  id: string;
  close: () => void;
  closeLabel: string;
}) {
  const note = useVaultNote(id);
  return (
    <article className="flex min-w-0 flex-col gap-3">
      <BackButton onClick={close}>{closeLabel}</BackButton>
      <h2 className="font-serif text-2xl font-semibold">
        {note.data?.title ?? "Idea"}
      </h2>
      <p className="text-sm text-muted-foreground">
        Read-only. Edit the note in Obsidian.
      </p>
      <div className="note-reading">
        <NoteBody id={id} />
      </div>
      {note.data ? (
        <div>
          <ObsidianLink path={note.data.path}>Open in Obsidian</ObsidianLink>
        </div>
      ) : null}
    </article>
  );
}
