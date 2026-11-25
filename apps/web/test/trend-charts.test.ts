import { expect, it } from "vitest";
import { barHeight, changeText, niceMax } from "../src/trend-charts";

it("rounds each chart's own scale up to a nice number", () => {
  expect(niceMax([0, 0])).toBe(1);
  expect(niceMax([3])).toBe(5);
  expect(niceMax([7, 12])).toBe(20);
  expect(niceMax([118, 96])).toBe(200);
  expect(niceMax([480])).toBe(500);
  expect(niceMax([1000])).toBe(1000);
});

it("draws columns to scale and keeps small non-zero values visible", () => {
  expect(barHeight(50, 100, 80)).toBe(40);
  expect(barHeight(0, 100, 80)).toBe(0);
  expect(barHeight(1, 1000, 80)).toBe(2);
  expect(barHeight(100, 100, 80)).toBe(80);
});

it("describes the change from the previous month in words and signs", () => {
  expect(changeText(120, 100, "Oct")).toBe("+20 vs Oct");
  expect(changeText(80, 100, "Oct")).toBe("−20 vs Oct");
  expect(changeText(5, 5, "Oct")).toBe("same as Oct");
  expect(changeText(5, undefined, "Oct")).toBeNull();
});
