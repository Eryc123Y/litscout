import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { projectsPage } from "@litscout/pipeline/vault-contracts";
import { apiGet } from "./api";
import { Button } from "./components/ui/button";
import { PageHeader } from "./PageHeader";
import { QueryState } from "./Notice";
import { LoadingState } from "./ReaderState";
import { ProjectsEmptyState } from "./VaultConventions";
import { SplitHandle, readListWidth, saveListWidth } from "./SplitHandle";
import { usePhoneLayout } from "./useMediaQuery";
import { countOf, formatDay } from "./format";
import { readPanel } from "./origin";
import { cn } from "./lib/utils";
import {
  ProjectDetail,
  StatusDot,
  readTab,
  firstTab,
  searchWith,
  type Project,
} from "./ProjectDetail";

const statusRank = (status: string) =>
  ({ active: 0, planning: 1 })[status.toLowerCase()] ?? 2;
const latestHit = (project: Project) =>
  project.radar.reduce(
    (latest, hit) => (hit.day > latest ? hit.day : latest),
    "",
  );

/** Active projects first, then planning, then the rest; within each, the
 * project the radar touched most recently comes first. */
export function orderProjects<T extends Project>(projects: readonly T[]) {
  return projects.toSorted(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      latestHit(b).localeCompare(latestHit(a)) ||
      a.title.localeCompare(b.title),
  );
}

const statusLabel = (status: string) =>
  status ? status[0]!.toUpperCase() + status.slice(1) : "No status";

export function Projects() {
  const query = useInfiniteQuery({
    queryKey: ["vault", "projects"],
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      apiGet(
        "/projects" + (pageParam ? "?after=" + pageParam : ""),
        projectsPage,
        signal,
      ),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (!query.data || items.length === 0)
    return (
      <main id="main" className="reader-page">
        <PageHeader
          title="Projects"
          description="Projects indexed from your vault."
        />
        {(query.isPending || query.isError) && (
          <QueryState
            query={query}
            label="Loading projects…"
            errorTitle="Projects unavailable"
          />
        )}
        {query.data && <ProjectsEmptyState />}
      </main>
    );
  const fetchMore = () => void query.fetchNextPage();
  return (
    <Workspace
      projects={orderProjects(items)}
      // More pages can hold a project named in the address.
      pages={
        !query.hasNextPage || query.isFetchNextPageError
          ? "done"
          : query.isFetchingNextPage
            ? "loading"
            : "more"
      }
      loadMore={fetchMore}
      more={
        <>
          {query.isFetchNextPageError ? (
            <p role="alert" className="px-2 text-sm text-destructive">
              More projects could not be loaded. {query.error?.message}
            </p>
          ) : null}
          {query.hasNextPage ? (
            <Button
              className="mx-2 mt-2 self-start"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={fetchMore}
            >
              {query.isFetchNextPageError
                ? "Retry loading projects"
                : "More projects"}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

/** The list of projects beside the one being read: the same two columns as
 * a day, each scrolling on its own. On a phone the list and the project
 * take turns. */
function Workspace({
  projects,
  pages,
  loadMore,
  more,
}: {
  projects: Project[];
  /** Whether more pages can be fetched, are on their way, or are done. */
  pages: "more" | "loading" | "done";
  loadMore: () => void;
  more: ReactNode;
}) {
  const [search, setSearch] = useSearchParams();
  const phone = usePhoneLayout();
  const wanted = search.get("project");
  const chosen = projects.find((p) => p.id === wanted);
  const selected = chosen ?? (wanted || phone ? undefined : projects[0]);
  const tab =
    readTab(search.get("tab")) ?? (selected ? firstTab(selected) : "radar");
  const openValue = search.get("open");
  const open = readPanel(openValue);
  const workspace = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [listWidth, setListWidth] = useState(readListWidth);
  const applyListWidth = (width: number) =>
    workspace.current?.style.setProperty("--list-width", `${width}px`);
  useLayoutEffect(() => {
    workspace.current?.style.setProperty("--list-width", `${listWidth}px`);
  }, [listWidth, phone]);

  // The address names the project being read. A project not on the loaded
  // pages is looked for on the next ones, then dropped; without one, the
  // first project is written in, so "More projects" cannot change it.
  const firstId = projects[0]?.id;
  useEffect(() => {
    if (wanted && !chosen) {
      if (pages === "more") loadMore();
      else if (pages === "done")
        setSearch(
          searchWith(search, { project: null, tab: null, open: null }),
          { replace: true },
        );
    } else if (!wanted && !phone && firstId)
      setSearch(searchWith(search, { project: firstId }), { replace: true });
  }, [wanted, chosen, pages, loadMore, phone, firstId, search, setSearch]);

  const close = () =>
    setSearch(searchWith(search, { open: null }), { replace: true });
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const inField = (event.target as Element | null)?.closest?.(
        "input, textarea, select, [role=dialog], [popover]",
      );
      if (!inField) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // A new view starts at its top. Opening or closing a paper or an idea
  // replaces the link that was used, so focus moves to the project's
  // column; on a phone, opening a project focuses its way back.
  const view = `${selected?.id}|${tab}|${openValue ?? ""}`;
  const lastOpen = useRef(openValue);
  useLayoutEffect(() => {
    if (pane.current) pane.current.scrollTop = 0;
    if (phone && chosen) document.documentElement.scrollTop = 0;
    if (lastOpen.current !== openValue)
      pane.current?.focus({ preventScroll: true });
    lastOpen.current = openValue;
  }, [view, phone, chosen, openValue]);
  const chosenId = chosen?.id;
  useLayoutEffect(() => {
    if (phone && chosenId) back.current?.focus({ preventScroll: true });
  }, [phone, chosenId]);

  const header = (
    <PageHeader
      title="Projects"
      description={`${countOf(projects.length, "project")} from your vault`}
    />
  );
  const list = (
    <nav aria-label="Projects list" className="flex min-w-0 flex-col gap-1">
      {groups(projects).map(([status, members]) => (
        <div key={status}>
          <h2 className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
            {statusLabel(status)}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {members.map((project) => (
              <li key={project.id}>
                <ProjectRow
                  project={project}
                  current={project.id === selected?.id}
                  search={search}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {more}
    </nav>
  );
  const detail = selected ? (
    <section
      ref={pane}
      tabIndex={-1}
      aria-label={"Project: " + selected.title}
      className="reading-pane reader-panel p-5 outline-none lg:p-6"
    >
      {phone ? (
        // One level up: from a paper or idea to its project, from a
        // project to the list.
        <div className="phone-reading-bar">
          <Button
            ref={back}
            variant="ghost"
            onClick={() =>
              open
                ? close()
                : setSearch(
                    searchWith(search, {
                      project: null,
                      tab: null,
                      open: null,
                    }),
                  )
            }
          >
            <ArrowLeft data-icon="inline-start" />
            {open ? "Back to " + selected.title : "Back to projects"}
          </Button>
        </div>
      ) : null}
      <ProjectDetail project={selected} tab={tab} open={open} close={close} />
    </section>
  ) : (
    <section aria-label="Project" className="reading-pane reader-panel p-5">
      <LoadingState compact label="Loading project…" />
    </section>
  );

  if (phone)
    return (
      <main
        id="main"
        className="reader-page"
        data-phone-reading={chosen ? true : undefined}
      >
        {chosen ? (
          detail
        ) : (
          <>
            {header}
            {list}
          </>
        )}
      </main>
    );
  return (
    // The title sits on the page, like every other page's; the two columns
    // fill the window under it.
    <main id="main" className="reader-page reader-workspace">
      {header}
      <div ref={workspace} className="reader-split">
        <div className="reader-list-pane">{list}</div>
        <SplitHandle
          width={listWidth}
          onChange={applyListWidth}
          onCommit={(width) => {
            setListWidth(width);
            saveListWidth(width);
          }}
          label="Resize the projects list"
        />
        {detail}
      </div>
    </main>
  );
}

function groups(projects: Project[]) {
  const byStatus = new Map<string, Project[]>();
  for (const project of projects)
    byStatus.set(project.status, [
      ...(byStatus.get(project.status) ?? []),
      project,
    ]);
  return [...byStatus];
}

function ProjectRow({
  project,
  current,
  search,
}: {
  project: Project;
  current: boolean;
  search: URLSearchParams;
}) {
  const last = latestHit(project);
  const facts = [
    project.radar.length
      ? `${countOf(project.radar.length, "radar hit")} · last ${formatDay(last)}`
      : "No radar hits",
    project.papers.length ? countOf(project.papers.length, "paper") : null,
    project.ideas.length ? countOf(project.ideas.length, "idea") : null,
  ].filter(Boolean);
  return (
    <Link
      to={{
        search: searchWith(search, {
          project: project.id,
          tab: null,
          open: null,
        }),
      }}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex flex-col gap-0.5 rounded-md px-2 py-2 text-foreground hover:bg-control",
        current && "bg-row-on",
      )}
    >
      <span className="flex items-center gap-2 font-serif text-base font-semibold">
        <StatusDot status={project.status} />
        {project.title}
      </span>
      <span
        className={cn(
          "ps-4 text-xs",
          project.radar.length ? "text-radar" : "text-muted-foreground",
        )}
      >
        {facts.join(" · ")}
      </span>
    </Link>
  );
}
