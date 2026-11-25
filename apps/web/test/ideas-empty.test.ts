// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { VaultTagEmptyState } from "../src/VaultConventions";

// The empty Ideas board says how ideas get in and what they are used for.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("explains how to add ideas and that open ones feed the digest's suggestions", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: false }, { status: 503 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(VaultTagEmptyState, { field: "ideaTag" }),
    ),
  );
  expect(await screen.findByText("No ideas indexed yet.")).toBeTruthy();
  expect(screen.getByText(/type\/idea/)).toBeTruthy();
  expect(
    screen.getByText(
      /Ideas marked seed or exploring also go to the morning digest, which suggests papers and combinations for them\./,
    ),
  ).toBeTruthy();
});

it("keeps the working-paper board's text to working papers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: false }, { status: 503 })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(VaultTagEmptyState, { field: "workingPaperTag" }),
    ),
  );
  expect(
    await screen.findByText("No working papers indexed yet."),
  ).toBeTruthy();
  expect(screen.queryByText(/morning digest/)).toBeNull();
});
