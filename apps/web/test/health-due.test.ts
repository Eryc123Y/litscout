import { expect, it } from "vitest";
import { dueText } from "../src/health-due";

it("says a digest is due on its reading day when the deadline is the end of the day", () => {
  expect(dueText("23:59")).toBe("on its reading day");
});

it("keeps a clock time for an earlier deadline", () => {
  expect(dueText("11:30")).toBe("by 11:30");
});
