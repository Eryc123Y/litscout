import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "./lib/utils";

/** The paper list's width beside the reader, in CSS pixels. */
export const listWidthMin = 280;
export const listWidthMax = 760;
export const listWidthDefault = 416;
export const listWidthKey = "litscout.listWidth";
const step = 16;
const bigStep = 64;

export function clampListWidth(width: number) {
  return Math.round(Math.min(listWidthMax, Math.max(listWidthMin, width)));
}

/** The width this browser last used; storage can be missing or blocked. */
export function readListWidth(
  storage: Storage | undefined = globalThis.localStorage,
) {
  try {
    const stored = storage?.getItem(listWidthKey);
    const value =
      stored === null || stored === undefined ? NaN : Number(stored);
    return Number.isFinite(value) ? clampListWidth(value) : listWidthDefault;
  } catch {
    return listWidthDefault;
  }
}

export function saveListWidth(
  width: number,
  storage: Storage | undefined = globalThis.localStorage,
) {
  try {
    storage?.setItem(listWidthKey, String(clampListWidth(width)));
  } catch {
    // A blocked store only means the width resets next visit.
  }
}

/** A divider that sizes the column beside it: drag it, or focus it and use
 * the arrow keys (Shift for bigger steps, Home and End for the ends). By
 * default it sizes the column on its left (the paper list); `invert` sizes
 * a column on its right (a side panel), so moving left widens it. */
export function SplitHandle({
  width,
  onChange,
  onCommit,
  label,
  className,
  min = listWidthMin,
  max = listWidthMax,
  invert = false,
}: {
  width: number;
  onChange: (width: number) => void;
  /** Called once a drag or key press settles, to save the width. */
  onCommit?: (width: number) => void;
  label: string;
  className?: string;
  min?: number;
  max?: number;
  invert?: boolean;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(Math.min(max, Math.max(min, value)));
  const sign = invert ? -1 : 1;
  const keys: Record<string, (shift: boolean) => number> = {
    ArrowLeft: (shift) => width - sign * (shift ? bigStep : step),
    ArrowRight: (shift) => width + sign * (shift ? bigStep : step),
    Home: () => min,
    End: () => max,
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = keys[event.key];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    const value = clamp(next(event.shiftKey));
    onChange(value);
    onCommit?.(value);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const value = clamp(
      drag.current.width + sign * (event.clientX - drag.current.x),
    );
    drag.current.last = value;
    onChange(value);
  };
  const onPointerEnd = () => {
    if (!drag.current) return;
    onCommit?.(drag.current.last);
    drag.current = null;
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      className={cn("split-handle", className)}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}
