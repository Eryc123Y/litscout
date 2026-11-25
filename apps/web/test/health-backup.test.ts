// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  backupBundleSchema,
  backupDataSections,
} from "@litscout/pipeline/backup-contracts";
import { verifyBackup } from "@litscout/pipeline/backup";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Health } from "../src/Health";
import { BackupDownload } from "../src/BackupDownload";

afterEach(cleanup);

it("shows digest timing and missing reports as distinct signals", async () => {
  const days = Array.from({ length: 30 }, (_, index) => ({
    day: new Date(Date.parse("2026-11-19") - (29 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    status: index === 29 ? "on-time" : "no-listing",
    reported: false,
    digestAt: index === 29 ? "2026-11-19T03:00:00.000Z" : null,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          timezone: "Asia/Shanghai",
          onTimeBy: "11:30",
          days,
          runs: [
            {
              id: "43d91359-fbdc-4047-a843-30e90031a4df",
              startedAt: "2026-11-19T02:00:00.000Z",
              finishedAt: null,
              targetDay: "2026-11-19",
              rowsWritten: null,
              steps: null,
            },
            {
              id: "b252ded4-acb7-45ba-9ca7-da862550bf1b",
              startedAt: "2026-11-18T02:00:00.000Z",
              finishedAt: "2026-11-18T02:02:00.000Z",
              targetDay: "2026-11-18",
              rowsWritten: 0,
              steps: {
                fetch: { status: "done" },
                summaries: { status: "paused", client: "api", error: "budget" },
                digest: { status: "skipped" },
                sync: { status: "skipped" },
                legacy: { status: "skipped" },
              },
            },
          ],
          budget: {
            used: 400,
            reserved: 50,
            limit: 75000,
            baseLimit: 80000,
            unaccounted: 12,
            estimateOverrun: 3,
            resetAt: "2026-11-20T00:00:00.000Z",
            rowsRead: 100,
          },
          storage: {
            sizeBytes: null,
            feedItems: 200,
            summaries: 160,
            vaultNotes: 20,
          },
          links: { unchecked: 200, capped: true },
          mirror: { activeAt: null, completedAt: null },
        },
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(createElement(QueryClientProvider, { client }, createElement(Health)));
  expect(
    await screen.findByRole("heading", { name: "Digest delivery" }),
  ).toBeTruthy();
  expect(screen.getByText("2026-11-19 · On time · No run report")).toBeTruthy();
  expect(screen.getByText("19 Nov").getAttribute("datetime")).toBe(
    "2026-11-19",
  );
  expect(screen.getByText(/19 Nov 2026, 10:00 GMT\+8/)).toBeTruthy();
  expect(screen.getByText("No completion report")).toBeTruthy();
  expect(screen.getByText("API")).toBeTruthy();
  expect(screen.getByText("Budget reached")).toBeTruthy();
  expect(screen.getByText("200+ unchecked links")).toBeTruthy();
  expect(screen.getByText(/75,000/)).toBeTruthy();
  expect(screen.getByText(/Safety margin: 5,000 writes/)).toBeTruthy();
  expect(screen.getByText(/12 unaccounted writes/)).toBeTruthy();
  expect(screen.getByText(/3 writes above estimates/)).toBeTruthy();
  // The gauge is styled with tokens: a native bar reads as full at 0.
  const gauge = screen.getByRole("progressbar", {
    name: "Write budget used or reserved",
  });
  expect(gauge.classList.contains("meter")).toBe(true);
  const css = readFileSync(resolve(__dirname, "../src/style.css"), "utf8");
  for (const part of [
    ".meter::-webkit-progress-bar",
    ".meter::-webkit-progress-value",
    ".meter::-moz-progress-bar",
  ])
    expect(css).toContain(part);
});

it("shows download progress and cancels an in-flight page request", async () => {
  let abort: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/backup"))
        return Response.json({
          success: true,
          data: {
            instanceName: "Test",
            configuredTopics: [],
            expectedCounts: Object.fromEntries(
              [...backupDataSections, "configuredTopics"].map((section) => [
                section,
                0,
              ]),
            ),
          },
        });
      abort = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        abort!.addEventListener("abort", () => reject(abort!.reason), {
          once: true,
        });
      });
    }),
  );
  render(createElement(BackupDownload));
  fireEvent.click(
    screen.getByRole("button", { name: "Download export bundle" }),
  );
  expect(
    await screen.findByRole("progressbar", { name: "Export progress" }),
  ).toBeTruthy();
  await waitFor(() => expect(abort).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
  expect(await screen.findByText("Download cancelled.")).toBeTruthy();
  expect(abort?.aborted).toBe(true);
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("shows the remaining export cooldown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { success: false, error: { code: "BACKUP_COOLDOWN" } },
        { status: 429, headers: { "Retry-After": "321" } },
      ),
    ),
  );
  render(createElement(BackupDownload));
  fireEvent.click(
    screen.getByRole("button", { name: "Download export bundle" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "321 seconds",
  );
});

it("writes a section to gzip before fetching the next section", async () => {
  const compressed = vi.fn();
  const NativeCompressionStream = CompressionStream;
  vi.stubGlobal(
    "CompressionStream",
    class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const probe = new TransformStream<BufferSource, BufferSource>({
          transform(chunk, controller) {
            compressed(new TextDecoder().decode(chunk));
            controller.enqueue(chunk);
          },
        });
        this.writable = probe.writable;
        this.readable = probe.readable.pipeThrough(
          new NativeCompressionStream(format),
        );
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/backup"))
        return Response.json({
          success: true,
          data: {
            instanceName: "Test",
            configuredTopics: [],
            expectedCounts: Object.fromEntries(
              [...backupDataSections, "configuredTopics"].map((section) => [
                section,
                Number(section === "topics"),
              ]),
            ),
          },
        });
      if (url.endsWith("/backup/alphaXiv"))
        expect(compressed.mock.calls.flat().join("")).toContain('"library":[]');
      return Response.json({
        success: true,
        data: { items: [], nextCursor: null },
      });
    }),
  );
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const objectUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue("blob:export");
  try {
    render(createElement(BackupDownload));
    fireEvent.click(
      screen.getByRole("button", { name: "Download export bundle" }),
    );
    expect(await screen.findByText("Download started.")).toBeTruthy();
    const blob = objectUrl.mock.calls[0]![0] as Blob;
    // The Blob is jsdom's or Node's depending on the runtime; jsdom's has no
    // arrayBuffer() and jsdom's FileReader rejects Node's Blob.
    const bytes =
      typeof blob.arrayBuffer === "function"
        ? await blob.arrayBuffer()
        : await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(blob);
          });
    const bundle = backupBundleSchema.parse(
      JSON.parse(gunzipSync(new Uint8Array(bytes)).toString()),
    );
    expect(verifyBackup(bundle)).toEqual([
      expect.stringMatching(/topics.*changed during export/i),
    ]);
    expect(bundle.expectedCounts.topics).toBe(1);
    expect(bundle.counts.library).toBe(0);
    expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(save).toHaveBeenCalledOnce();
  } finally {
    objectUrl.mockRestore();
    save.mockRestore();
  }
});
