import { useEffect, useState, type ComponentType } from "react";

type Props = {
  text: string;
  /** GitHub-flavoured Markdown, as Obsidian notes use it. */
  gfm?: boolean;
};

let View: ComponentType<Props> | undefined;
let loading: Promise<void> | undefined;

/** Loads the Markdown parser (react-markdown, GFM, math, the sanitizer): a
 * third of the first script that Today rarely needs at once. The app calls
 * this when the browser is idle, so it is usually there before it is used. */
export function preloadMarkdown() {
  return (loading ??= import("./MarkdownView").then((module) => {
    View = module.MarkdownView;
  }));
}

/** Markdown, with the parser loaded on demand: the text shows as written
 * until it arrives, then renders in place. */
export function Markdown(props: Props) {
  const [, setReady] = useState(Boolean(View));
  useEffect(() => {
    if (View) return;
    let mounted = true;
    void preloadMarkdown().then(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return View ? (
    <View {...props} />
  ) : (
    <div className="markdown markdown-pending">{props.text}</div>
  );
}
