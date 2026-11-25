import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { BackupProgress } from "@litscout/pipeline/backup";
import { countOf } from "./format";
import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Leave the URL available while the browser begins the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The export button with its progress and result, for any container. */
export function BackupControls({ secondary = false }: { secondary?: boolean }) {
  const announce = usePageAnnouncement();
  const running = useRef<AbortController | null>(null);
  const [active, setActive] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [result, setResult] = useState<{
    failed: boolean;
    text: string;
  } | null>(null);

  const phase =
    progress && progress.completed === progress.total
      ? "Compressing export…"
      : "Preparing export…";
  const announcement = result?.text ?? (active ? phase : null);
  useEffect(() => {
    if (announcement) announce?.(announcement);
  }, [announce, announcement]);

  useEffect(
    () => () => {
      running.current?.abort();
      running.current = null;
    },
    [],
  );

  async function download() {
    if (running.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    running.current = controller;
    setActive(true);
    setProgress(null);
    setResult(null);
    let backupError:
      typeof import("@litscout/pipeline/backup").BackupError | undefined;
    try {
      const { BackupError, backupFilename, backupJson, backupReader } =
        await import("@litscout/pipeline/backup");
      backupError = BackupError;
      const createdAt = new Date();
      const read = backupReader((path, init) =>
        fetch(path, { ...init, credentials: "same-origin" }),
      );
      const chunks = backupJson(read, {
        createdAt,
        signal,
        onProgress: setProgress,
      });
      const utf8 = new TextEncoder();
      const json = new ReadableStream<BufferSource>(
        {
          async pull(stream) {
            const chunk = await chunks.next();
            if (chunk.done) stream.close();
            else stream.enqueue(utf8.encode(chunk.value));
          },
          async cancel() {
            await chunks.return(undefined);
          },
        },
        { highWaterMark: 0 },
      );
      const gzip = json.pipeThrough(new CompressionStream("gzip"), { signal });
      const blob = await new Response(gzip, {
        headers: { "Content-Type": "application/gzip" },
      }).blob();
      signal.throwIfAborted();
      save(blob, backupFilename(createdAt.toISOString()));
      setResult({ failed: false, text: "Download started." });
    } catch (error) {
      if (running.current === controller)
        setResult(
          signal.aborted
            ? { failed: false, text: "Download cancelled." }
            : {
                failed: true,
                text:
                  backupError && error instanceof backupError
                    ? error.message
                    : "Could not download the export. Check your connection and sign-in, then retry.",
              },
        );
    } finally {
      if (running.current === controller) {
        running.current = null;
        setActive(false);
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant={secondary ? "secondary" : "default"}
          disabled={active}
          onClick={() => void download()}
        >
          <Download aria-hidden="true" />
          Download export bundle
        </Button>
        {active ? (
          <Button variant="outline" onClick={() => running.current?.abort()}>
            Cancel download
          </Button>
        ) : null}
      </div>
      {active ? (
        <>
          <progress
            className="block h-2 w-full max-w-sm accent-primary"
            max={progress?.total}
            value={progress?.completed}
            aria-label="Export progress"
          />
          <LoadingState
            compact
            label={
              progress && progress.completed < progress.total
                ? `${countOf(progress.records, "record")} read`
                : phase
            }
          />
        </>
      ) : null}
      {result &&
        (result.failed ? (
          <EmptyState
            compact
            role="alert"
            live={!announce}
            title={result.text}
          />
        ) : (
          <p
            role={announce ? undefined : "status"}
            className="text-sm text-subtle"
          >
            {result.text}
          </p>
        ))}
    </div>
  );
}

export function BackupDownload() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Export</h2>
        </CardTitle>
        <CardDescription>
          Download a gzip bundle of your library, digests and research records.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BackupControls />
      </CardContent>
    </Card>
  );
}
