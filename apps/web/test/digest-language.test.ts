import { expect, it } from "vitest";
import { digestLanguageNote } from "../src/Digest";

it("labels a digest written in another language than the instance's", () => {
  expect(digestLanguageNote("zh", "en")).toBe("Written in Chinese");
  expect(digestLanguageNote("en", "zh")).toBe("Written in English");
  expect(digestLanguageNote("en", "en")).toBeNull();
  expect(digestLanguageNote(undefined, "en")).toBeNull();
});
