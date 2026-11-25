import { getConfig } from "@testing-library/react";
import { expect, it, vi } from "vitest";

it("waits long enough for pages that load on demand, and keeps the network blocked", () => {
  // Secondary pages are lazy (M4o); a busy machine needs more than the 1 s default.
  expect(getConfig().asyncUtilTimeout).toBe(5_000);
  // The shared setup still applies to the web project.
  // (calling it would fail that setup's own after-each check).
  expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
});
