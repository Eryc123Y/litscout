import { parse } from "csv-parse/sync";
import { headerCell, tableRects, type Rect } from "./pdf-table";
import type { VenueRecord, VenueTable } from "@litscout/sources/sources/venue";
const CCF = "https://www.ccf.org.cn/Academic_Evaluation/By_category/";
const ICORE =
  "https://portal.core.edu.au/conf-ranks/?search=&by=all&source=ICORE2026&sort=atitle&page=1&do=Export";
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  width?: number;
}
export function parseIcore(csv: string, source: string): VenueRecord[] {
  const rows = parse(csv, {
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];
  const records = rows.flatMap((row) => {
    if (!/^\d+$/.test(row[0] ?? "") || !/^(?:I?CORE)\d{4}$/.test(row[3] ?? ""))
      return [];
    return [
      {
        name: row[1]!.trim(),
        acronym: row[2]!.trim(),
        ranks: [
          {
            system: "ICORE" as const,
            rank: row[4]!,
            year: Number(row[3]!.slice(-4)),
            source,
          },
        ],
      },
    ];
  });
  if (!records.length)
    throw new Error("ICORE export format changed or is empty");
  return records;
}
function lines(items: PdfItem[]): string[] {
  const rows = new Map<number, PdfItem[]>();
  for (const item of items) {
    const y = Math.round(item.y / 3) * 3;
    rows.set(y, [...(rows.get(y) ?? []), item]);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(""),
    );
}
export function parseCcfPages(
  pages: PdfItem[][],
  source: string,
  cells: Rect[][] = [],
): VenueRecord[] {
  const year = Number(
    pages
      .flatMap(lines)
      .join(" ")
      .match(/(20\d{2})\s*年/)?.[1],
  );
  if (!year) throw new Error("CCF edition year missing");
  let rank: string | undefined;
  const venues: VenueRecord[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const items = page.filter((i) => i.str.trim());
    const rankLine = lines(items).find((s) => /[ABC]\s*类/.test(s));
    if (rankLine) rank = rankLine.match(/([ABC])\s*类/)?.[1];
    const numberHead = items.find((i) => i.str === "序号");
    const acronymHead = items.find((i) => i.str.includes("简称"));
    const publisherHead = items.find((i) => i.str === "出版社");
    if (!numberHead || !acronymHead || !publisherHead || !rank) continue;
    const anchors = items
      .filter(
        (i) =>
          i.x < numberHead.x + 30 &&
          i.y < numberHead.y - 5 &&
          /^\d+$/.test(i.str),
      )
      .sort((a, b) => b.y - a.y);
    const acronymCell = headerCell(cells[pageIndex] ?? [], acronymHead);
    const publisherCell = headerCell(cells[pageIndex] ?? [], publisherHead);
    const titleLeft =
      acronymCell?.[2] ?? acronymHead.x + (acronymHead.width ?? 45) + 15;
    const titleRight = publisherCell?.[0] ?? publisherHead.x - 15;
    const linkLeft = publisherCell?.[2] ?? publisherHead.x + 25;
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index]!;
      const top =
        index === 0 ? numberHead.y - 5 : (anchors[index - 1]!.y + anchor.y) / 2;
      const bottom =
        index === anchors.length - 1
          ? anchor.y - 25
          : (anchors[index + 1]!.y + anchor.y) / 2;
      const row = items.filter((i) => i.y < top && i.y >= bottom);
      const titleItems = row.filter(
        (i) => i.x >= titleLeft && i.x < titleRight && !/出版社/.test(i.str),
      );
      const name = lines(titleItems).join(" ").replace(/\s+/g, " ").trim();
      const acronym = lines(
        row.filter((i) => i.x >= numberHead.x + 30 && i.x < titleLeft),
      )
        .join("")
        .trim();
      const link = lines(row.filter((i) => i.x >= linkLeft))
        .join("")
        .replace(/\s+/g, "");
      const dblp = link.match(/\/db\/((?:conf|journals)\/[^/\s]+)/)?.[1];
      if (name)
        venues.push({
          name,
          acronym,
          dblp,
          ranks: [{ system: "CCF", rank, year, source }],
        });
    }
  }
  if (!venues.length)
    throw new Error("CCF PDF table layout changed or is empty");
  return venues;
}
export async function parseCcfPdf(
  bytes: Uint8Array,
  source: string,
): Promise<VenueRecord[]> {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: bytes,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages: PdfItem[][] = [];
    const cells: Rect[][] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      cells.push(tableRects(await page.getOperatorList(), OPS));
      pages.push(
        content.items.flatMap((item) =>
          "str" in item
            ? [
                {
                  str: item.str,
                  x: item.transform[4]!,
                  y: item.transform[5]!,
                  width: item.width,
                },
              ]
            : [],
        ),
      );
    }
    return parseCcfPages(pages, source, cells);
  } finally {
    await task.destroy();
  }
}
const transientDownloadCodes = new Set([
  "EAI_AGAIN",
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
function retryableDownload(error: unknown) {
  if (error instanceof DOMException && error.name === "TimeoutError")
    return true;
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause ?? error;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    transientDownloadCodes.has(cause.code)
  );
}
/** Venue sources can be slow but steady (the CCF PDF arrives at about 6 KB/s,
 * near a minute for 347 KB), so a request fails when no bytes arrive for
 * `stallMs`, and one attempt never runs longer than `totalMs`. */
export interface DownloadLimits {
  stallMs: number;
  totalMs: number;
}
const defaultLimits: DownloadLimits = { stallMs: 30_000, totalMs: 180_000 };
function attemptClock(limits: DownloadLimits) {
  const controller = new AbortController();
  const expire = () =>
    controller.abort(
      new DOMException("Venue source timed out", "TimeoutError"),
    );
  let stall = setTimeout(expire, limits.stallMs);
  const total = setTimeout(expire, limits.totalMs);
  return {
    signal: controller.signal,
    progress() {
      clearTimeout(stall);
      stall = setTimeout(expire, limits.stallMs);
    },
    stop() {
      clearTimeout(stall);
      clearTimeout(total);
    },
  };
}
/** Settles with `promise`, or rejects with the abort reason first: a stuck
 * stream that ignores the signal must not hold the deploy. */
function unlessAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
async function readBytes(
  response: Response,
  clock: ReturnType<typeof attemptClock>,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await unlessAborted(reader.read(), clock.signal);
      if (done) break;
      chunks.push(value);
      clock.progress();
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return bytes;
}
async function download(
  fetchImpl: typeof fetch,
  url: string,
  limits: DownloadLimits,
): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const clock = attemptClock(limits);
    try {
      const response = await unlessAborted(
        fetchImpl(url, { signal: clock.signal }),
        clock.signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error("Venue source download failed"), {
          status: response.status,
        });
      }
      return await readBytes(response, clock);
    } catch (error) {
      const failure: unknown = clock.signal.aborted
        ? clock.signal.reason
        : error;
      if (attempt || !retryableDownload(failure)) throw failure;
    } finally {
      clock.stop();
    }
  }
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export async function fetchVenueTables(
  fetchImpl: typeof fetch = fetch,
  pdfParser = parseCcfPdf,
  limits: DownloadLimits = defaultLimits,
): Promise<VenueTable> {
  const introduction = text(await download(fetchImpl, CCF, limits));
  const href = introduction.match(
    /href=["']([^"']*\/ccf\/contentcore\/resource\/download\?ID=[^"']+)["']/i,
  )?.[1];
  if (!href) throw new Error("CCF official download link missing");
  const pdfUrl = new URL(href.replace(/&amp;/g, "&"), CCF);
  if (pdfUrl.origin !== "https://www.ccf.org.cn")
    throw new Error("Unexpected CCF download host");
  const ccf = await pdfParser(
    await download(fetchImpl, pdfUrl.href, limits),
    pdfUrl.href,
  );
  const icore = parseIcore(
    text(await download(fetchImpl, ICORE, limits)),
    ICORE,
  );
  const venues = [...ccf];
  for (const record of icore) {
    // Names must agree: an acronym collision does not establish venue identity.
    const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const index = venues.findIndex(
      (v) => normalized(v.name) === normalized(record.name),
    );
    if (index < 0) venues.push(record);
    else
      venues[index] = {
        ...venues[index]!,
        ranks: [...venues[index]!.ranks, ...record.ranks],
      };
  }
  return { downloaded_at: new Date().toISOString(), venues };
}
