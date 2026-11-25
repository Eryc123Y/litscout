import { useEffect, useRef } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { MathText, plainMath } from "./math-text";

/** An arXiv PDF beside the summary, in the browser's own PDF viewer. Only
 * arXiv is framed (the Worker's CSP allows frame-src https://arxiv.org). */
export function PdfPanel({
  title,
  url,
  onClose,
}: {
  title: string;
  /** A framable arXiv PDF: without one the reader keeps its two columns. */
  url: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  // Opening brings the reading area to the top (the morning brief can push
  // it below the fold); the panel then sticks under the 44 px top bar.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: "start" });
  }, []);
  return (
    <section
      ref={panel}
      aria-label="PDF"
      // Lets the page frame drop its width cap while a PDF is open.
      data-pdf-open=""
      className="reader-panel sticky top-15 flex h-[calc(100dvh-4.75rem)] min-w-0 scroll-mt-15 flex-col overflow-hidden p-0"
    >
      <div className="flex items-center gap-1 border-b py-1.5 pr-1.5 pl-4">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          <MathText text={title} />
        </p>
        <Button asChild variant="ghost" size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open in new tab
            <ArrowUpRight
              aria-hidden="true"
              className="text-muted-foreground"
            />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close PDF"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <iframe
        key={url}
        title={"PDF: " + plainMath(title)}
        src={url}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </section>
  );
}
