// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  SplitHandle,
  clampListWidth,
  listWidthDefault,
  listWidthMax,
  listWidthMin,
  readListWidth,
} from "../src/SplitHandle";
import { relativeDay } from "../src/format";

afterEach(cleanup);

it("names a listing day relative to today", () => {
  expect(relativeDay("2026-11-21", "2026-11-21")).toBe("Today");
  expect(relativeDay("2026-11-20", "2026-11-21")).toBe("Yesterday");
  expect(relativeDay("2026-11-17", "2026-11-21")).toBe("4 days ago");
  expect(relativeDay("2026-10-30", "2026-11-21")).toBe("22 days ago");
  expect(relativeDay("2026-11-22", "2026-11-21")).toBe("Tomorrow");
  expect(relativeDay("2026-11-25", "2026-11-21")).toBe("In 4 days");
});

it("keeps the list width inside its bounds and ignores unreadable values", () => {
  expect(clampListWidth(100)).toBe(listWidthMin);
  expect(clampListWidth(5000)).toBe(listWidthMax);
  expect(clampListWidth(500.6)).toBe(501);
  const storage = (value: string | null) =>
    ({ getItem: () => value }) as unknown as Storage;
  expect(readListWidth(storage("520"))).toBe(520);
  expect(readListWidth(storage("9999"))).toBe(listWidthMax);
  expect(readListWidth(storage("wide"))).toBe(listWidthDefault);
  expect(readListWidth(storage(null))).toBe(listWidthDefault);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  expect(readListWidth(throwing)).toBe(listWidthDefault);
});

it("resizes the list from the keyboard and reports each width", () => {
  const onChange = vi.fn();
  render(
    createElement(SplitHandle, {
      width: 400,
      onChange,
      label: "Resize the paper list",
    }),
  );
  const handle = screen.getByRole("separator", {
    name: "Resize the paper list",
  });
  expect(handle.getAttribute("aria-orientation")).toBe("vertical");
  expect(handle.getAttribute("aria-valuenow")).toBe("400");
  expect(handle.getAttribute("aria-valuemin")).toBe(String(listWidthMin));
  expect(handle.getAttribute("aria-valuemax")).toBe(String(listWidthMax));
  expect(handle.tabIndex).toBe(0);
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith(416);
  fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith(336);
  fireEvent.keyDown(handle, { key: "Home" });
  expect(onChange).toHaveBeenLastCalledWith(listWidthMin);
  fireEvent.keyDown(handle, { key: "End" });
  expect(onChange).toHaveBeenLastCalledWith(listWidthMax);
  // Other keys pass through (j / k still move between papers).
  fireEvent.keyDown(handle, { key: "j" });
  expect(onChange).toHaveBeenCalledTimes(4);
});
