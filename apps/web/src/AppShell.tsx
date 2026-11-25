import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, matchPath, useLocation } from "react-router";
import {
  Sun,
  CalendarDays,
  Settings,
  Rss,
  Activity,
  ChartNoAxesCombined,
  LibraryBig,
  FolderOpen,
  FolderSync,
  Lightbulb,
  FileText,
  Ellipsis,
  Moon,
  type LucideIcon,
} from "lucide-react";
import type { ThemeName } from "./theme";
import type { PageProps } from "./App";
import { useFeedCounts } from "./api";
import { today } from "./model";
import { formatCount } from "./format";
import { cn } from "./lib/utils";
import { SidePanel } from "./SidePanel";
import { SearchPapers } from "./SearchPapers";
import { readOrigin } from "./origin";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { usePhoneLayout } from "./useMediaQuery";

type NavGroup = "Read" | "Research" | "System";
type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  active: boolean;
  group: NavGroup;
};

// Pages put actions (search, choose a day) into the desktop top bar through
// this slot. On phones, and before the bar mounts, they render in place.
const TopBarSlot = createContext<HTMLElement | null>(null);
/** The page's horizontal frame, shared by the top bar and the content:
 * full width up to 88rem, centred beyond it. */
const pageFrame = "page-frame mx-auto w-full max-w-[88rem]";

export function TopBarActions({ children }: { children: ReactNode }) {
  const slot = useContext(TopBarSlot);
  return slot ? createPortal(children, slot) : <>{children}</>;
}
/** True when page actions go to the desktop top bar rather than the page. */
export function useTopBar() {
  return useContext(TopBarSlot) !== null;
}

export function AppShell({
  instance,
  isPublic,
  children,
  theme,
  onAppearance,
}: PageProps & {
  children: ReactNode;
  theme: ThemeName;
  onAppearance: (mode: "light" | "dark") => void;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [phoneSlot, setPhoneSlot] = useState<HTMLElement | null>(null);
  const base = isPublic ? "/public" : "/app",
    location = useLocation();
  const phone = usePhoneLayout();
  // Search sits in the top bar of every signed-in page. A day page puts its
  // own there (that day's papers first), so the shell leaves it alone.
  const dayPage = ["/app", "/app/today", "/app/days/:day"].some((pattern) =>
    matchPath(pattern, location.pathname),
  );
  const pageSearch =
    isPublic || dayPage ? null : (
      <SearchPapers everyDay topVenues={instance.topVenues} />
    );
  useLayoutEffect(() => {
    if (!phone) return;
    window.scrollTo(0, 0);
    // Query changes, including opening a paper, keep their scroll position.
  }, [location.pathname, phone]);
  // A full paper opened from another page keeps that page highlighted.
  const paperPage = location.pathname.startsWith(`${base}/papers/`);
  const from = paperPage ? readOrigin(location.state) : null;
  const pathname = from
    ? new URL(from.path, "http://localhost").pathname
    : location.pathname;
  const onToday = ["/", base, `${base}/today`].some((path) =>
    matchPath(path, pathname),
  );
  const listingDay = matchPath(`${base}/days/:day`, pathname)?.params.day;
  const onArchive = Boolean(matchPath(`${base}/days`, pathname));
  // Today's badge. Where today's feed is on the page it fills the counts
  // itself, so the shell asks only elsewhere.
  const todayDay = today(instance.timezone);
  const todayFeedOnPage =
    ["/", base, `${base}/today`].some((path) =>
      matchPath(path, location.pathname),
    ) ||
    matchPath(`${base}/days/:day`, location.pathname)?.params.day === todayDay;
  const feed = useFeedCounts(todayDay, isPublic, !todayFeedOnPage);
  const counts = feed.data?.counts;
  const item = (
    group: NavGroup,
    label: string,
    href: string,
    icon: LucideIcon,
    active: boolean,
  ): NavItem => ({ group, label, href, icon, active });
  const here = (path: string) => pathname === path;
  const nav: NavItem[] = [
    item(
      "Read",
      "Today",
      `${base}/today`,
      Sun,
      onToday || (paperPage && !from),
    ),
    item(
      "Read",
      "Days",
      `${base}/days`,
      CalendarDays,
      onArchive || Boolean(listingDay),
    ),
    ...(!isPublic
      ? [
          item(
            "Read",
            "Library",
            "/app/library",
            LibraryBig,
            here("/app/library"),
          ),
          item(
            "Read",
            "Trends",
            "/app/trends",
            ChartNoAxesCombined,
            here("/app/trends"),
          ),
          item(
            "Research",
            "Projects",
            "/app/projects",
            FolderOpen,
            here("/app/projects"),
          ),
          item(
            "Research",
            "Ideas",
            "/app/ideas",
            Lightbulb,
            here("/app/ideas"),
          ),
          item(
            "Research",
            "Working papers",
            "/app/working-papers",
            FileText,
            /^\/app\/working-papers(?:\/|$)/.test(pathname),
          ),
          item(
            "System",
            "Vault sync",
            "/app/vault",
            FolderSync,
            here("/app/vault"),
          ),
          item(
            "System",
            "Health",
            "/app/health",
            Activity,
            here("/app/health"),
          ),
          item(
            "System",
            "Settings",
            "/app/settings",
            Settings,
            here("/app/settings"),
          ),
        ]
      : []),
  ];
  const publicFeed = !isPublic && instance.publicFeed;
  const current =
    nav.find(({ active }) => active)?.label ??
    (location.pathname.includes("/papers/") ? "Paper" : instance.name);
  const appearance = (
    <div
      role="group"
      aria-label="Appearance"
      className="flex gap-0.5 rounded-sm bg-control p-0.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 aria-pressed:bg-pressed max-md:size-11"
        aria-label="Light appearance"
        aria-pressed={theme === "journal"}
        onClick={() => onAppearance("light")}
      >
        <Sun aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 aria-pressed:bg-pressed max-md:size-11"
        aria-label="Dark appearance"
        aria-pressed={theme === "graphite"}
        onClick={() => onAppearance("dark")}
      >
        <Moon aria-hidden="true" />
      </Button>
    </div>
  );
  const groups = (["Read", "Research"] as const).filter((group) =>
    nav.some((entry) => entry.group === group),
  );
  const system = nav.filter(({ group }) => group === "System");
  return (
    <div className="app-shell min-h-screen md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
      {phone && (
        <header className="phone-chrome phone-brand flex items-center justify-between gap-2 border-b bg-card px-4">
          <Link
            to={`${base}/today`}
            className="flex min-h-11 min-w-0 items-center gap-2.5 font-semibold text-foreground"
          >
            <BrandMark />
            <span className="wrap-anywhere">{instance.name}</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            {pageSearch}
            <div ref={setPhoneSlot} className="contents" />
          </div>
          {appearance}
        </header>
      )}
      <aside
        aria-label="Sidebar"
        className="hidden flex-col gap-6 border-b bg-card px-3 py-5 lg:px-3.5 md:sticky md:top-0 md:flex md:h-screen md:border-r md:border-b-0"
      >
        <Link
          to={`${base}/today`}
          className="flex items-center gap-2.5 px-2 text-foreground"
        >
          <BrandMark />
          <span className="flex flex-col md:sr-only lg:not-sr-only">
            <span className="text-[15px] font-semibold">{instance.name}</span>
            <span className="text-xs text-muted-foreground md:hidden lg:inline">
              {isPublic ? "Public reading" : "Your daily reading"}
            </span>
          </span>
        </Link>
        <nav aria-label="Main" className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group} className="flex flex-col gap-0.5">
              <h2 className="px-2.5 pb-1 text-xs font-semibold text-muted-foreground md:sr-only lg:not-sr-only">
                {group}
              </h2>
              <ul
                aria-label={group}
                className="m-0 flex list-none flex-col gap-0.5 p-0"
              >
                {nav
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <li key={entry.label}>
                      <SidebarLink
                        {...entry}
                        count={
                          entry.label === "Today" && counts
                            ? formatCount(counts.shortlisted)
                            : undefined
                        }
                      />
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </nav>
        {system.length > 0 && (
          <nav aria-label="System" className="mt-auto border-t pt-3">
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {system.map((entry) => (
                <li key={entry.label}>
                  <SidebarLink {...entry} />
                </li>
              ))}
            </ul>
          </nav>
        )}
      </aside>
      <div className="phone-content flex min-w-0 flex-col">
        {!phone && (
          <header
            aria-label="Top bar"
            className="sticky top-0 z-20 flex min-h-11 items-center border-b bg-card px-4 md:px-6 lg:px-9"
          >
            {/* The same frame as the page below, so their edges line up. */}
            <div className={cn(pageFrame, "flex items-center gap-2")}>
              <span className="min-w-0 truncate text-sm font-medium text-subtle">
                {current}
              </span>
              <div className="ml-auto flex items-center gap-2">
                {pageSearch}
                <div ref={setSlot} className="contents" />
              </div>
              {publicFeed && (
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="text-subtle"
                >
                  <Link to="/public/today">
                    <Rss data-icon="inline-start" aria-hidden="true" />
                    Public feed
                  </Link>
                </Button>
              )}
              {appearance}
            </div>
          </header>
        )}
        <TopBarSlot.Provider value={phone ? phoneSlot : slot}>
          <div className="shell-body flex-1 px-4 py-4 md:px-6 md:py-5 lg:px-9 lg:pt-4 lg:pb-7">
            {/* Keyed by path: each visit to a page gets one entrance. */}
            <div
              key={location.pathname}
              className={cn(pageFrame, "page-enter")}
            >
              {children}
            </div>
          </div>
        </TopBarSlot.Provider>
        {isPublic ? null : <SidePanel />}
      </div>
      {phone && (
        <PhoneNavigation
          key={location.pathname}
          nav={[
            ...nav,
            ...(publicFeed
              ? [item("System", "Public feed", "/public/today", Rss, false)]
              : []),
          ]}
        />
      )}
    </div>
  );
}

function SidebarLink({
  label,
  href,
  icon: Icon,
  active,
  count,
}: NavItem & { count?: string }) {
  return (
    <Link
      to={href}
      title={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-9 items-center gap-2.5 rounded-sm px-2.5 text-subtle hover:bg-control md:justify-center lg:justify-start",
        active && "bg-row-on font-semibold text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="md:sr-only lg:not-sr-only">{label}</span>
      {count !== undefined ? (
        <span className="ml-auto text-xs text-muted-foreground md:hidden lg:inline">
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function BrandMark() {
  return (
    <span
      className="relative flex size-8 shrink-0 items-center justify-center rounded-sm bg-foreground font-serif text-xl text-card"
      aria-hidden="true"
    >
      L
      <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
    </span>
  );
}

const primaryLabels = ["Today", "Days", "Library", "Ideas"];

function PhoneNavigation({ nav }: { nav: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const primary = nav.filter(({ label }) => primaryLabels.includes(label));
  const more = nav.filter(({ label }) => !primaryLabels.includes(label));
  return (
    <nav
      aria-label="Main"
      className="phone-chrome phone-nav fixed inset-x-0 bottom-0 z-30 flex border-t bg-card px-2 pt-1"
    >
      {primary.map(({ label, href, icon: Icon, active }) => (
        <Link
          key={label}
          to={href}
          aria-current={active ? "page" : undefined}
          className="phone-nav-item"
        >
          <Icon size={20} aria-hidden="true" />
          {label}
        </Link>
      ))}
      {more.length > 0 && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            className="phone-nav-item"
            data-active={more.some(({ active }) => active)}
          >
            <Ellipsis size={20} aria-hidden="true" />
            More
          </DialogTrigger>
          <DialogContent className="phone-sheet" aria-describedby={undefined}>
            <DialogTitle>More</DialogTitle>
            <nav aria-label="More pages" className="grid gap-1">
              {more.map(({ label, href, icon: Icon, active }) => (
                <Link
                  key={label}
                  to={href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className="flex min-h-11 items-center gap-3 rounded-sm px-2 text-foreground aria-[current=page]:bg-row-on aria-[current=page]:font-semibold"
                >
                  <Icon size={18} aria-hidden="true" />
                  {label}
                </Link>
              ))}
            </nav>
          </DialogContent>
        </Dialog>
      )}
    </nav>
  );
}
