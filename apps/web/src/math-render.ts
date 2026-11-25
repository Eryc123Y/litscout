import { useEffect, useState } from "react";

/** TeX to a MathML string; throws on TeX it cannot parse. */
export type RenderMath = (tex: string, display: boolean) => string;

let loaded: RenderMath | null = null;
let pending: Promise<RenderMath> | null = null;

/** Temml (MathML only, no CSS or fonts) loads on first use as its own chunk. */
export function loadMath(): Promise<RenderMath> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= import("temml")
    .then(({ default: temml }) => {
      loaded = (tex, display) =>
        temml.renderToString(tex, {
          displayMode: display,
          throwOnError: true,
          trust: false,
        });
      return loaded;
    })
    .catch((error: unknown) => {
      // A failed chunk load leaves the raw TeX in place; the next note retries.
      pending = null;
      throw error;
    });
  return pending;
}

/** The renderer once loaded, or null while it loads, fails or is not needed. */
export function useMathRenderer(needed: boolean): RenderMath | null {
  const [render, setRender] = useState<RenderMath | null>(() => loaded);
  useEffect(() => {
    if (!needed || render) return;
    let live = true;
    loadMath().then(
      (next) => live && setRender(() => next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [needed, render]);
  return render;
}
