/** The Ideas board's drag state, kept pure so pointer and keyboard drags
 * share one set of rules. A drag is either over a column or over nothing;
 * dropping over the column it came from moves nothing. */
export type DragState<S extends string = string> = {
  id: string;
  from: S;
  over: S | null;
  mode: "pointer" | "keyboard";
  columns: readonly S[];
  dx: number;
  dy: number;
} | null;

export type DragAction<S extends string = string> =
  | {
      type: "pick";
      id: string;
      from: S;
      mode: "pointer" | "keyboard";
      columns: readonly S[];
    }
  | { type: "over"; column: S | null; dx: number; dy: number }
  | { type: "step"; by: -1 | 1 }
  | { type: "end" };

export function dragReducer<S extends string>(
  state: DragState<S>,
  action: DragAction<S>,
): DragState<S> {
  if (action.type === "pick")
    return {
      id: action.id,
      from: action.from,
      over: action.from,
      mode: action.mode,
      columns: action.columns,
      dx: 0,
      dy: 0,
    };
  if (!state || action.type === "end") return null;
  if (action.type === "over")
    return { ...state, over: action.column, dx: action.dx, dy: action.dy };
  const at = state.columns.indexOf(state.over ?? state.from);
  const next = Math.min(state.columns.length - 1, Math.max(0, at + action.by));
  return { ...state, over: state.columns[next] ?? state.over };
}

/** The move a drop would make, or null when it lands nowhere new. */
export function dropMove<S extends string>(state: DragState<S>) {
  return state && state.over && state.over !== state.from
    ? { id: state.id, to: state.over }
    : null;
}
