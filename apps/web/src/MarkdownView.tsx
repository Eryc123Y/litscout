import { memo, useMemo } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  hasMath,
  markdownSchema,
  rehypeMathML,
  remarkMathSpans,
} from "./math-markdown";
import { useMathRenderer } from "./math-render";
import { safeUrl } from "./model";

const mathPlugins: Options["remarkPlugins"] = [remarkMath, remarkMathSpans];
/** Tables, task lists and autolinks for vault notes. A single tilde stays
 * text, so "~5%" in a summary is not struck through. */
const notePlugins: Options["remarkPlugins"] = [
  [remarkGfm, { singleTilde: false }],
  ...mathPlugins,
];
const sanitize: Options["rehypePlugins"] = [[rehypeSanitize, markdownSchema]];

/** Markdown with `$...$` and `$$...$$` math as MathML. Memoised: an editor's
 * live preview re-parses only when the text changes. Loaded on demand
 * through `Markdown.tsx`, so the parser stays out of the first script. */
export const MarkdownView = memo(function MarkdownView({
  text,
  gfm = false,
}: {
  text: string;
  /** GitHub-flavoured Markdown, as Obsidian notes use it. */
  gfm?: boolean;
}) {
  // Temml loads only for text that contains math; until then the TeX shows.
  const render = useMathRenderer(hasMath(text));
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => (render ? [[rehypeMathML, render], ...sanitize!] : sanitize),
    [render],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={gfm ? notePlugins : mathPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        urlTransform={(url) => safeUrl(url) ?? ""}
        components={{
          a: ({ href, children }) =>
            safeUrl(href) ? (
              <a href={href} rel="noopener noreferrer" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
          // Task list boxes are read-only and need a name.
          input: ({ type, checked }) =>
            type === "checkbox" ? (
              <input
                type="checkbox"
                checked={Boolean(checked)}
                readOnly
                disabled
                aria-label={checked ? "Done" : "To do"}
              />
            ) : null,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
