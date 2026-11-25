// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Days } from "../src/Days";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("H2 offers older days after a full default page of thirty", async () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.parse("2026-11-16") - i * 86400000)
      .toISOString()
      .slice(0, 10),
    status: "crawled",
    counts: { total: 2, sources: { arxiv: 2 } },
  }));
  const fetcher = vi.fn(async (_url: RequestInfo | URL) =>
    Response.json({
      success: true,
      data: { items: days, nextBefore: days.at(-1)!.day },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      QueryClientProvider,
      {
        client: new QueryClient({
          defaultOptions: { queries: { retry: false } },
        }),
      },
      createElement(
        MemoryRouter,
        {},
        createElement(Days, { isPublic: true, timezone: "UTC" }),
      ),
    ),
  );
  const older = await screen.findByRole("button", { name: "Older days" });
  fireEvent.click(older);
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some((args) =>
        String(args[0]).includes(`before=${days.at(-1)!.day}`),
      ),
    ).toBe(true),
  );
});
