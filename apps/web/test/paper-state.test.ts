// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaperActions, ReadStatus } from "../src/PaperActions";

// Opening a paper reports the open and gets the reading state back in the
// same answer, so it does not also ask for the state.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (data: unknown) => Response.json({ success: true, data });
const state = {
  paperId: "pap_a",
  readAt: "2026-11-21T06:00:00.000Z",
  starred: true,
  readLater: false,
  rating: "none",
  libraryRev: null,
};
function mount(
  client: QueryClient,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const spy = vi.fn(fetcher);
  vi.stubGlobal("fetch", spy);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ReadStatus, { paperId: "pap_a" }),
      createElement(PaperActions, { paperId: "pap_a", inReader: true }),
    ),
  );
  const calls = (method: string, part: string) =>
    spy.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(part) && (init?.method ?? "GET") === method,
    ).length;
  return calls;
}
const newClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

it("takes the reading state from the open report, with no request of its own", async () => {
  const calls = mount(newClient(), async (_url, init) =>
    init?.method === "POST"
      ? json(state)
      : json({ items: [], nextCursor: null }),
  );
  expect(await screen.findByText("Read")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Star" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(calls("POST", "/events")).toBe(1);
  expect(calls("GET", "/state")).toBe(0);
});

it("asks for the state when the open report fails", async () => {
  const calls = mount(newClient(), async (_url, init) =>
    init?.method === "POST"
      ? Response.json(
          { success: false, error: { message: "down" } },
          { status: 500 },
        )
      : json({ items: [{ ...state, starred: false }], nextCursor: null }),
  );
  await waitFor(() => expect(calls("GET", "/state")).toBe(1));
  expect(await screen.findByText("Read")).toBeTruthy();
});

it("asks for the state of a paper already opened in this session", async () => {
  const client = newClient();
  const first = mount(client, async (_url, init) =>
    init?.method === "POST"
      ? json(state)
      : json({ items: [state], nextCursor: null }),
  );
  await screen.findByText("Read");
  expect(first("POST", "/events")).toBe(1);
  cleanup();
  client.removeQueries();
  // Opened again later: no second open report, so the state is fetched.
  const second = mount(client, async (_url, init) =>
    init?.method === "POST"
      ? json(state)
      : json({ items: [state], nextCursor: null }),
  );
  await screen.findByText("Read");
  expect(second("POST", "/events")).toBe(0);
  expect(second("GET", "/state")).toBe(1);
});

it("says Read at once in a reader that is reporting the open, with no Unread flash", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await held;
      return json(state);
    }),
  );
  render(
    createElement(
      QueryClientProvider,
      { client: newClient() },
      createElement(ReadStatus, {
        paperId: "pap_a",
        readAt: null,
        opening: true,
      }),
      createElement(PaperActions, { paperId: "pap_a", inReader: true }),
    ),
  );
  expect(screen.getByText("Read")).toBeTruthy();
  expect(screen.queryByText("Unread")).toBeNull();
  release();
  await waitFor(() => expect(screen.getByText("Read")).toBeTruthy());
  // Without an open on its way, an unread paper still says Unread.
  cleanup();
  render(
    createElement(
      QueryClientProvider,
      { client: newClient() },
      createElement(ReadStatus, { paperId: "pap_b", readAt: null }),
    ),
  );
  expect(screen.getByText("Unread")).toBeTruthy();
});
