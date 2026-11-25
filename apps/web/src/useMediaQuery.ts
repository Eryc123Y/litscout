import { useCallback, useSyncExternalStore } from "react";

const serverSnapshot = () => false;

export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = globalThis.matchMedia?.(query);
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    [query],
  );
  const snapshot = useCallback(
    () => globalThis.matchMedia?.(query).matches ?? false,
    [query],
  );
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function usePhoneLayout() {
  return useMediaQuery("(width < 48rem)");
}
