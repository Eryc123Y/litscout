import type { ServerStatus } from "@litscout/pipeline/server-contracts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { cn } from "./lib/utils";

/** The scheduled runs on an own server, in their daily order. */
const timers = [
  ["main", "Morning"],
  ["retry", "Retry"],
  ["final", "Evening"],
] as const;
/** Short times ("22 Nov, 09:43"): the tile is narrow and Health names the
 * time zone in its heading. */
const shortTimes = new Map<string, Intl.DateTimeFormat>();
function shortTime(at: string, timezone: string) {
  let format = shortTimes.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    });
    shortTimes.set(timezone, format);
  }
  return format.format(new Date(at));
}
/** Storage is measured in binary gigabytes, as on the server. */
const gigabytes = (bytes: number) =>
  (bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "");
const megabytes = (bytes: number) =>
  (bytes / 1_000_000).toLocaleString("en", { maximumFractionDigits: 1 });

function Dot({ tone }: { tone: "ok" | "warn" | "error" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 translate-y-[-1px] rounded-full",
        tone === "ok"
          ? "bg-good"
          : tone === "warn"
            ? "bg-late"
            : "bg-destructive",
      )}
    />
  );
}

/** The own server's newest report: its storage against the cap, the newest
 * snapshot and the last run of each timer. */
export function ServerTile({
  server,
  timezone,
  className,
}: {
  server: ServerStatus | null;
  timezone: string;
  className?: string;
}) {
  const when = (at: string) => shortTime(at, timezone);
  if (!server)
    return (
      <Card className={className}>
        <CardHeader className="gap-1">
          <CardTitle>
            <h2>Server</h2>
          </CardTitle>
          <CardDescription>No report from the server yet</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-subtle">
          The server reports after each scheduled run.
        </CardContent>
      </Card>
    );
  const { footprintBytes, warningBytes, capBytes, snapshot, runs } = server;
  const used = Math.min(100, Math.round((100 * footprintBytes) / capBytes));
  return (
    <Card className={className}>
      <CardHeader className="gap-1">
        <CardTitle>
          <h2>Server</h2>
        </CardTitle>
        <CardDescription>
          {gigabytes(footprintBytes)} GB of {gigabytes(capBytes)} GB
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <progress
          className="meter"
          value={used}
          max={100}
          aria-label="Server storage used"
        />
        {footprintBytes > capBytes ? (
          <p className="flex items-baseline gap-2">
            <Dot tone="error" />
            Over the {gigabytes(capBytes)} GB cap: the oldest archived papers go
            first
          </p>
        ) : footprintBytes > warningBytes ? (
          <p className="flex items-baseline gap-2">
            <Dot tone="warn" />
            Above the {gigabytes(warningBytes)} GB warning level
          </p>
        ) : null}
        <p>
          {snapshot
            ? `Snapshot ${when(snapshot.at)} · ${megabytes(snapshot.bytes)} MB`
            : "No snapshot yet"}
        </p>
        <ul
          aria-label="Last run of each timer"
          className="m-0 grid list-none gap-1 p-0 text-xs"
        >
          {timers.map(([mode, label]) => {
            const run = runs.find((item) => item.mode === mode);
            return (
              <li key={mode} className="flex items-baseline gap-2">
                <span className="w-16 shrink-0 font-medium">{label}</span>
                <span className="min-w-0 flex-1 text-subtle">
                  {run ? when(run.startedAt) : ""}
                </span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  {run && <Dot tone={run.failed ? "error" : "ok"} />}
                  {run ? (run.failed ? "Failed" : "OK") : "No run yet"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          Reported {when(server.checkedAt)}
        </p>
      </CardContent>
    </Card>
  );
}
