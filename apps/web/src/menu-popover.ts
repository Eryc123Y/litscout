import { useEffect, type RefObject } from "react";

/** A native popover used as a menu: opening it moves focus to its first item,
 * and focus leaving it closes it (popover light dismiss reacts only to clicks
 * outside and Escape, so tabbing past the last item would leave it open). */
export function useMenuPopover(menu: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "open")
        element
          .querySelector<HTMLElement>("button:not(:disabled), a[href]")
          ?.focus();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !element.contains(next))
        element.hidePopover?.();
    };
    element.addEventListener("toggle", onToggle);
    element.addEventListener("focusout", onFocusOut);
    return () => {
      element.removeEventListener("toggle", onToggle);
      element.removeEventListener("focusout", onFocusOut);
    };
  }, [menu]);
}
