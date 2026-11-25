import type { CrawlDeps } from "./source-crawl";

function abortable<T>(signal: AbortSignal, start: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(start)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
}

export async function withCrawlDeadline<T>(
  deps: CrawlDeps,
  seconds: number,
  crawl: (active: CrawlDeps) => Promise<T>,
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Crawl deadline reached after ${seconds} seconds`),
    );
  }, seconds * 1000);
  try {
    return await crawl({
      ...deps,
      signal,
      fetch: (input, init) =>
        abortable(signal, () => {
          const request =
            init?.signal ??
            (input instanceof Request ? input.signal : undefined);
          return deps.fetch(input, {
            ...init,
            signal: request ? AbortSignal.any([signal, request]) : signal,
          });
        }),
      sleep: (ms) => abortable(signal, () => deps.sleep(ms, signal)),
    });
  } finally {
    clearTimeout(timer);
  }
}
