import { afterEach, expect, vi } from "vitest";

// Install before test modules load. Explicit vi.stubGlobal mocks restore to
// this blocker during cleanup, even if a suite unstubs its own globals.
const blockedFetch = vi.fn<typeof fetch>(() => {
  throw new Error("Network disabled in unit tests; install a fixture mock");
});
globalThis.fetch = blockedFetch;

afterEach(() => {
  try {
    expect(
      blockedFetch,
      "An HTTP request reached the unit-test fetch blocker",
    ).not.toHaveBeenCalled();
  } finally {
    blockedFetch.mockClear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
