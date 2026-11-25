import { expect, it } from "vitest";
import { indexParts } from "../src/vault-sync";

// Note bodies (vault.uploadBodies) make index notes large: a part stays
// well under the 1 MB vault request cap by size as well as by count.
const noteOf = (size: number, id: string) => ({ id, body: "字".repeat(size) });
const bytes = (part: unknown[]) =>
  new TextEncoder().encode(JSON.stringify(part)).byteLength;

it("splits index notes by count and by size", () => {
  const small = Array.from({ length: 13 }, (_, i) => noteOf(10, `n${i}`));
  expect(indexParts(small).map((part) => part.length)).toEqual([12, 1]);

  // 30,000 CJK characters are about 90 KB of JSON each.
  const large = Array.from({ length: 9 }, (_, i) => noteOf(30_000, `b${i}`));
  const parts = indexParts(large);
  expect(parts.flat()).toHaveLength(9);
  for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(400_000);
  expect(parts.length).toBeGreaterThan(1);
});

it("keeps an empty list as no parts", () => {
  expect(indexParts([])).toEqual([]);
});
