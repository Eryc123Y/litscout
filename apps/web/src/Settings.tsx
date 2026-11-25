import type { ReactNode } from "react";
import { Link } from "react-router";
import { PageHeader } from "./PageHeader";
import { EmptyState } from "./ReaderState";
import type { ThemeMode, ThemePrefs } from "./theme";
import { TopicLabel } from "./TopicLabel";
import { BackupControls } from "./BackupDownload";
import { cn } from "./lib/utils";

const appearance: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "Follow the system" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

export function Settings({
  prefs,
  onChange,
  topics,
}: {
  prefs: ThemePrefs;
  onChange: (p: ThemePrefs) => void;
  topics: string[];
}) {
  return (
    <main id="main" className="reader-page">
      <PageHeader
        title="Settings"
        description="Appearance, topics and your data."
      />
      <div className="page-column flex flex-col rounded-lg bg-card">
        <SettingRow title="Appearance" hint="Saved in this browser">
          <fieldset className="m-0 border-0 p-0">
            <legend className="sr-only">Appearance</legend>
            <div
              role="radiogroup"
              aria-label="Appearance"
              className="grid gap-2 sm:grid-cols-3"
            >
              {appearance.map(({ mode, label }) => (
                <label
                  key={mode}
                  className={cn(
                    "flex cursor-pointer flex-col gap-2 rounded-sm bg-control p-1.5 text-sm text-subtle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    prefs.mode === mode &&
                      "bg-pressed text-foreground ring-2 ring-primary ring-inset",
                  )}
                >
                  <Preview mode={mode} />
                  <span className="flex items-center gap-2 px-1 pb-0.5">
                    <input
                      type="radio"
                      name="appearance"
                      value={mode}
                      checked={prefs.mode === mode}
                      onChange={() => onChange({ mode })}
                      className="accent-primary"
                    />
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </SettingRow>
        <SettingRow title="Topics" hint="Set in the instance configuration">
          {topics.length ? (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {topics.map((topic) => (
                <li key={topic}>
                  <TopicLabel topic={topic} topics={topics} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No topics configured." />
          )}
        </SettingRow>
        <SettingRow
          title="Your data"
          hint="Library, digests and research records"
        >
          <div className="flex flex-col gap-3">
            <BackupControls secondary />
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link
                to="/app/vault"
                className="text-primary underline-offset-4 hover:underline"
              >
                Vault sync
              </Link>
              <Link
                to="/app/health"
                className="text-primary underline-offset-4 hover:underline"
              >
                Health
              </Link>
            </p>
          </div>
        </SettingRow>
      </div>
    </main>
  );
}

function SettingRow({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-3 border-t px-4 py-4 first:border-t-0 md:grid-cols-[180px_minmax(0,1fr)] md:gap-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

const swatch = {
  light: { page: "#f6f7f9", ink: "#16181d", line: "#b8b8bc", block: "#e8e8e4" },
  dark: { page: "#121213", ink: "#ececee", line: "#5a5a60", block: "#2c2c31" },
};

function Preview({ mode }: { mode: ThemeMode }) {
  const half = (tone: keyof typeof swatch) => (
    <span
      className="flex flex-1 flex-col gap-1 p-1.5"
      style={{ background: swatch[tone].page }}
    >
      <span
        className="h-1 w-3/5 rounded-full"
        style={{ background: swatch[tone].ink }}
      />
      <span
        className="h-0.5 w-2/5 rounded-full"
        style={{ background: swatch[tone].line }}
      />
      <span
        className="mt-1 h-3 rounded-[3px]"
        style={{ background: swatch[tone].block }}
      />
    </span>
  );
  return (
    <span
      aria-hidden="true"
      className="flex h-14 overflow-hidden rounded-[6px] ring-1 ring-border"
    >
      {mode !== "dark" && half("light")}
      {mode !== "light" && half("dark")}
    </span>
  );
}
