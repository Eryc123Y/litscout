import { expect, it } from "vitest";
import { dragReducer, dropMove, type DragState } from "../src/ideas-drag";

const columns = ["seed", "exploring", "in-paper", "parked"] as const;
const pick = (mode: "pointer" | "keyboard"): DragState =>
  dragReducer(null, {
    type: "pick",
    id: "idea_1",
    from: "seed",
    mode,
    columns,
  });

it("picks up a card over its own column; dropping there is no move", () => {
  const state = pick("keyboard");
  expect(state).toMatchObject({ id: "idea_1", from: "seed", over: "seed" });
  expect(dropMove(state)).toBeNull();
  expect(dragReducer(state, { type: "end" })).toBeNull();
});

it("moves between columns with the keyboard and stops at the ends", () => {
  let state = pick("keyboard");
  state = dragReducer(state, { type: "step", by: 1 });
  expect(state?.over).toBe("exploring");
  for (let i = 0; i < 3; i++)
    state = dragReducer(state, { type: "step", by: 1 });
  expect(state?.over).toBe("parked");
  state = dragReducer(state, { type: "step", by: -1 });
  expect(state?.over).toBe("in-paper");
  expect(dropMove(state)).toEqual({ id: "idea_1", to: "in-paper" });
});

it("follows the pointer and has no target outside the columns", () => {
  let state = pick("pointer");
  state = dragReducer(state, {
    type: "over",
    column: "exploring",
    dx: 40,
    dy: -8,
  });
  expect(state).toMatchObject({ over: "exploring", dx: 40, dy: -8 });
  expect(dropMove(state)).toEqual({ id: "idea_1", to: "exploring" });
  state = dragReducer(state, { type: "over", column: null, dx: 400, dy: 0 });
  expect(state?.over).toBeNull();
  expect(dropMove(state)).toBeNull();
  // Escape ends the drag the same way, with nothing moved.
  expect(dragReducer(state, { type: "end" })).toBeNull();
  expect(dropMove(null)).toBeNull();
});
