import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./components/ui/button";
import { TopicLabel } from "./TopicLabel";

/** The commands that fetch the first day, run where litscout.config.ts is. */
export const firstCommands = [
  "litscout token create --name scheduler --scopes read,ingest --save-only",
  "litscout daily fetch --json",
];
const guide = "https://github.com/Eryc123Y/litscout/blob/main/docs";

/** Commands in a block, with a button that copies them. The status beside
 * the button is the visible feedback and the live region at once. */
function Commands({ lines, label }: { lines: string[]; label: string }) {
  const id = useId();
  const [status, setStatus] = useState<"" | "Copied" | "Copy failed">("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    setStatus("");
    let next: "Copied" | "Copy failed" = "Copied";
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      next = "Copy failed";
    }
    // A frame later, so a repeated message is announced again.
    requestAnimationFrame(() => setStatus(next));
    timer.current = setTimeout(() => setStatus(""), 2500);
  }
  return (
    <div className="flex flex-col gap-2">
      <pre
        id={id}
        className="overflow-x-auto rounded-md bg-control px-3 py-2.5 font-mono text-[13px] leading-relaxed"
      >
        <code>{lines.join("\n")}</code>
      </pre>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-controls={id}
          onClick={() => void copy()}
        >
          {status === "Copied" ? (
            <Check data-icon="inline-start" aria-hidden="true" />
          ) : (
            <Copy data-icon="inline-start" aria-hidden="true" />
          )}
          {label}
        </Button>
        <span
          role="status"
          className={
            status === "Copy failed"
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {status}
        </span>
      </div>
    </div>
  );
}

/** The reader on a new LitScout, before its first fetch: what it does, the
 * reader's own topics, and the next step. */
export function FirstRun({
  topics,
  keywordOnly,
}: {
  topics: readonly string[];
  keywordOnly: boolean;
}) {
  const id = useId();
  const topicsId = `${id}-topics`;
  return (
    <section
      aria-labelledby={id}
      className="flex max-w-prose flex-col gap-5 text-sm leading-relaxed"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={id} className="font-serif text-xl font-semibold">
          Welcome to LitScout
        </h2>
        <p className="text-subtle">
          This is your own LitScout, and it has not fetched any papers yet. Each
          day it reads the new arXiv listing for your categories, and the
          journals and conferences you watch, and puts the papers that match
          your topics first.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 id={topicsId} className="text-xs font-semibold text-subtle">
          Your topics
        </h3>
        {topics.length ? (
          <ul
            aria-labelledby={topicsId}
            className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          >
            {topics.map((topic) => (
              <li key={topic}>
                <TopicLabel topic={topic} topics={[...topics]} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-subtle">
            None yet: add some to <code>topics</code> in litscout.config.ts.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-subtle">
          Fetch your first day
        </h3>
        <p>In a terminal, in the folder that holds litscout.config.ts, run:</p>
        <Commands lines={firstCommands} label="Copy the commands" />
        <p className="text-subtle">
          The fetch reports the listing date it read; open that day from Days.
          After that, a schedule can run the fetch each morning.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-subtle">Change your setup</h3>
        <p className="text-subtle">
          Topics, categories, language and venues live in litscout.config.ts and
          venues.json. After editing them, apply the change: on a trial on this
          computer, run <code>litscout server init --local --force</code> and
          restart the server; on Cloudflare, run <code>litscout deploy</code>;
          on your own server, run <code>litscout server init --force</code> and
          restart the service.
        </p>
        {keywordOnly && (
          <p className="text-subtle">
            Summaries and the morning brief are off, so the papers show their
            abstracts. To turn them on, sign in to Claude Code or Codex on the
            computer that runs the fetch, set <code>agent.mode</code> to{" "}
            <code>"client"</code> and apply the change.
          </p>
        )}
        <p>
          <a
            className="text-primary underline-offset-4 hover:underline"
            href={`${guide}/try-locally.md`}
            rel="noreferrer"
            target="_blank"
          >
            The setup guide
          </a>
        </p>
      </div>
    </section>
  );
}
