import { useCallback } from "react";
import { applyTopicColour } from "./topic-colours";
export function useTopicColour(index: number) {
  return useCallback(
    (element: HTMLElement | null) => applyTopicColour(element, index),
    [index],
  );
}
