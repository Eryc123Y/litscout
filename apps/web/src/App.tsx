import { lazy, Suspense, useEffect } from "react";
import { Link, Routes, Route, useLocation, useNavigate } from "react-router";
import type { InstanceInfo } from "@litscout/pipeline/web-contracts";
import { useInstance } from "./api";
import { useTheme } from "./theme";
import { legacyRoute } from "./model";
import { Notice } from "./Notice";
import { PageHeader } from "./PageHeader";
import { LoadingState, PageAnnouncements } from "./ReaderState";
import { Feed } from "./Feed";
import { VaultSync } from "./Vault";
import { AppShell } from "./AppShell";
import { useDocumentTitle } from "./useDocumentTitle";
import { Button } from "./components/ui/button";

// Pages other than the reader load when first opened. Vault sync stays in
// the entry chunk because the Paper page imports Vault.tsx.
const Projects = lazy(() =>
  import("./Projects").then((m) => ({ default: m.Projects })),
);
const Days = lazy(() => import("./Days").then((m) => ({ default: m.Days })));
const Trends = lazy(() =>
  import("./Trends").then((m) => ({ default: m.Trends })),
);
const Library = lazy(() =>
  import("./Library").then((m) => ({ default: m.Library })),
);
const Ideas = lazy(() => import("./Ideas").then((m) => ({ default: m.Ideas })));
const WorkingPapers = lazy(() =>
  import("./WorkingPapers").then((m) => ({ default: m.WorkingPapers })),
);
const WorkingPaper = lazy(() =>
  import("./WorkingPapers").then((m) => ({ default: m.WorkingPaper })),
);
const Health = lazy(() =>
  import("./Health").then((m) => ({ default: m.Health })),
);
const Settings = lazy(() =>
  import("./Settings").then((m) => ({ default: m.Settings })),
);
export type PageProps = { isPublic: boolean; instance: InstanceInfo };
export function App() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-sm focus:bg-card focus:p-3"
      >
        Skip to content
      </a>
      <AppContent />
    </>
  );
}
function AppContent() {
  const instance = useInstance(),
    theme = useTheme();
  const location = useLocation(),
    navigate = useNavigate();
  const isPublic = !/^\/app(?:\/|$)/.test(location.pathname);
  useDocumentTitle();
  useEffect(() => {
    if (instance.data) {
      const target = legacyRoute(
        location.hash,
        instance.data.publicFeed,
        instance.data.topics,
      );
      if (target) navigate(target, { replace: true });
      document.documentElement.lang = instance.data.language;
    }
  }, [instance.data, location.hash, navigate]);
  if (instance.isPending || instance.isError)
    return (
      <>
        <div className="px-4 py-6 md:px-6 lg:px-9 lg:py-7">
          <Notice
            query={instance}
            title="LitScout"
            description="Your daily reading."
            label="Loading LitScout…"
            errorTitle="Feed unavailable"
            actions={
              <Button asChild variant="outline">
                <a href="/app/today">Sign in</a>
              </Button>
            }
          />
          <p className="mt-6 text-xs text-muted-foreground">
            <a href="/health">Service status</a>
          </p>
        </div>
      </>
    );
  if (isPublic && !instance.data.publicFeed) return <Landing />;
  const props = { instance: instance.data, isPublic };
  return (
    <AppShell
      {...props}
      theme={theme.theme}
      onAppearance={(mode) => theme.setPrefs({ mode })}
    >
      <Suspense
        fallback={
          <main id="main" className="reader-page">
            <LoadingState label="Loading page" />
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<Feed {...props} />} />
          {["/public", "/app"].map((prefix) => (
            <Route key={prefix} path={prefix}>
              <Route index element={<Feed {...props} />} />
              <Route path="today" element={<Feed {...props} />} />
              <Route
                path="days"
                element={
                  <Days
                    isPublic={isPublic}
                    timezone={instance.data.timezone}
                    keywordOnly={instance.data.keywordOnly}
                  />
                }
              />
              <Route path="days/:day" element={<Feed {...props} />} />
              <Route
                path="papers/:id"
                element={<Feed {...props} paperPage />}
              />
            </Route>
          ))}
          <Route
            path="/app/trends"
            element={<Trends instance={instance.data} />}
          />
          <Route
            path="/app/library"
            element={
              <Library
                timezone={props.instance.timezone}
                topVenues={props.instance.topVenues}
              />
            }
          />
          <Route path="/app/projects" element={<Projects />} />
          <Route
            path="/app/ideas"
            element={
              <PageAnnouncements key="ideas">
                <Ideas timezone={instance.data.timezone} />
              </PageAnnouncements>
            }
          />
          <Route path="/app/working-papers" element={<WorkingPapers />} />
          <Route
            path="/app/working-papers/:id"
            element={
              <PageAnnouncements key={location.pathname}>
                <WorkingPaper topics={instance.data.topics} />
              </PageAnnouncements>
            }
          />
          <Route
            path="/app/vault"
            element={<VaultSync timezone={props.instance.timezone} />}
          />
          <Route
            path="/app/health"
            element={
              <PageAnnouncements key="health">
                <Health />
              </PageAnnouncements>
            }
          />
          <Route
            path="/app/settings"
            element={
              <PageAnnouncements key="settings">
                <Settings
                  prefs={theme.prefs}
                  onChange={theme.setPrefs}
                  topics={instance.data.topics}
                />
              </PageAnnouncements>
            }
          />
          <Route
            path="*"
            element={
              <main id="main" className="p-6">
                <PageHeader
                  title="Page not found"
                  description="Return to the daily paper listing."
                  actions={
                    <Button asChild variant="outline">
                      <Link to={`${isPublic ? "/public" : "/app"}/today`}>
                        Today
                      </Link>
                    </Button>
                  }
                />
              </main>
            }
          />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
function Landing() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16"
    >
      <p className="font-semibold">LitScout</p>
      <PageHeader
        title="Your research, one day at a time."
        description="Sign in to read your daily papers and digest."
        actions={
          <Button asChild>
            <a href="/app/today">Sign in</a>
          </Button>
        }
      />
    </main>
  );
}
