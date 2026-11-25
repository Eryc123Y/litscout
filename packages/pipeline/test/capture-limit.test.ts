import { expect, it } from "vitest";
import { captureEdit, newVaultRequest } from "../src/vault-contracts";

// A capture written on the web is a note, not a one-liner (2026-11-20):
// up to 10,000 characters of Markdown.
it("accepts a capture body up to 10,000 characters and refuses longer", () => {
  const capture = (body: string) =>
    newVaultRequest.safeParse({ kind: "capture", title: "A note", body });
  expect(capture("x".repeat(10_000)).success).toBe(true);
  expect(capture("x".repeat(10_001)).success).toBe(false);
  expect(
    captureEdit.safeParse({ title: "A note", body: "x".repeat(10_000) })
      .success,
  ).toBe(true);
  expect(
    captureEdit.safeParse({ title: "A note", body: "x".repeat(10_001) })
      .success,
  ).toBe(false);
});
