import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchVenueTables } from "../src/fetch-venues";
import { operationalReason } from "../src/operational-errors";
it("R6 preserves HTTP status without copying source response bodies into the error", async () => {
  const hidden = "private upstream body";
  const fetcher = vi.fn(async () => new Response(hidden, { status: 503 }));
  const error = await fetchVenueTables(fetcher as typeof fetch).catch(
    (error) => error,
  );
  expect(error).toMatchObject({ status: 503 });
  expect(String(error)).not.toContain(hidden);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("retries a timed-out venue body with a fresh signal before parsing it", async () => {
  const href = "/ccf/contentcore/resource/download?ID=123";
  const pdfUrl = `https://www.ccf.org.cn${href}`;
  const timeout = new DOMException("upstream details", "TimeoutError");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(`<a href="${href}">PDF</a>`))
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(timeout),
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    .mockResolvedValueOnce(new Response("123,Test Conference,TC,ICORE2026,A"));
  const parsePdf = vi.fn(async () => []);
  const table = await fetchVenueTables(fetcher, parsePdf);
  expect(table.venues).toHaveLength(1);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://www.ccf.org.cn/Academic_Evaluation/By_category/",
    pdfUrl,
    pdfUrl,
    expect.stringContaining("portal.core.edu.au"),
  ]);
  expect(fetcher.mock.calls[1]?.[1]?.signal).not.toBe(
    fetcher.mock.calls[2]?.[1]?.signal,
  );
  expect(parsePdf).toHaveBeenCalledExactlyOnceWith(
    new Uint8Array([1, 2, 3]),
    pdfUrl,
  );
});
it("limits venue retries to one and reports DOM timeout code 23 as a timeout", async () => {
  const timeout = new DOMException("private upstream details", "TimeoutError");
  expect(timeout.code).toBe(23);
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(timeout);
  const error = await fetchVenueTables(fetcher).catch(
    (failure: unknown) => failure,
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(operationalReason(error)).toBe("request timed out");
  expect(operationalReason({ code: 23 })).toBe("error code 23");
});

describe("slow venue sources (CCF sends its PDF at about 6 KB/s)", () => {
  const href = "/ccf/contentcore/resource/download?ID=123";
  const page = () => new Response(`<a href="${href}">PDF</a>`);
  const icore = () => new Response("123,Test Conference,TC,ICORE2026,A");
  /** A body that sends `chunks` single bytes, one every `every` ms, then closes
   * (or never closes when chunks is Infinity). */
  const trickle = (every: number, chunks: number) => {
    let sent = 0;
    let cancelled = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              if (cancelled) return resolve();
              if (sent >= chunks) controller.close();
              else controller.enqueue(new Uint8Array([++sent]));
              resolve();
            }, every);
          }),
        cancel: () => {
          cancelled = true;
        },
      }),
    );
  };
  /** A body that sends one byte, then nothing. */
  const stalled = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new Uint8Array([9])),
        pull: () => new Promise<void>(() => {}),
      }),
    );
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps reading while bytes keep arriving, even past 30 s in total", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(trickle(20_000, 3))
      .mockResolvedValueOnce(icore());
    const parsePdf = vi.fn(async () => []);
    const table = fetchVenueTables(fetcher, parsePdf);
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(table).resolves.toMatchObject({
      venues: [{ name: "Test Conference" }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(parsePdf).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([1, 2, 3]),
      `https://www.ccf.org.cn${href}`,
    );
  });

  it("gives up on a source that stops sending for 30 s, retrying once", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(stalled())
      .mockResolvedValueOnce(stalled());
    const failure = fetchVenueTables(
      fetcher,
      vi.fn(async () => []),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(operationalReason(await failure)).toBe("request timed out");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("caps one attempt at 180 s even while bytes keep trickling in", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(trickle(10_000, Infinity))
      .mockResolvedValueOnce(trickle(10_000, Infinity));
    const failure = fetchVenueTables(
      fetcher,
      vi.fn(async () => []),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(181_000);
    expect(operationalReason(await failure)).toBe("request timed out");
  });
});
