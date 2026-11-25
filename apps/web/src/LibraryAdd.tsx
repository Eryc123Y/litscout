import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  saveResultSchema,
  type SaveCandidate,
} from "@litscout/pipeline/library-contracts";
import { Plus } from "lucide-react";
import { apiMutation } from "./api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { EmptyState, LoadingState } from "./ReaderState";
import { PageMetadataNotice } from "./PageMetadataNotice";
import { MathText } from "./math-text";
import { fieldClass, labelClass } from "./library-ui";
import { linkLabel } from "./LibraryRows";

/** "Add paper" opens the DOI, URL, arXiv ID or title lookup in a dialog;
 * saving closes it and reports the paper on the page. */
export function AddPaperDialog({
  onSaved,
}: {
  onSaved: (title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add paper
        </Button>
      </DialogTrigger>
      <DialogContent
        className="phone-sheet sm:max-w-xl"
        aria-describedby={undefined}
      >
        <DialogTitle>Add a paper</DialogTitle>
        <AddPaperForm
          onSaved={(title) => {
            setOpen(false);
            onSaved(title);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddPaperForm({ onSaved }: { onSaved: (title: string) => void }) {
  const [input, setInput] = useState("");
  const [matches, setMatches] = useState<SaveCandidate[] | null>(null);
  const client = useQueryClient();
  const request = useMutation({
    mutationFn: ({ query, dry_run }: { query: string; dry_run: boolean }) =>
      apiMutation(
        "/library/save",
        "POST",
        { query, dry_run },
        saveResultSchema,
      ),
    onSuccess: (result, args) => {
      if (result.status === "confirm") setMatches(result.candidates);
      else {
        onSaved(matches?.find((m) => m.query === args.query)?.title ?? "Paper");
        setInput("");
        setMatches(null);
        void client.invalidateQueries({ queryKey: ["library"] });
        void client.invalidateQueries({
          queryKey: ["reading-state", result.paperId],
        });
      }
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          setMatches(null);
          request.mutate({ query: input.trim(), dry_run: true });
        }}
      >
        <label className={labelClass + " min-w-48 flex-1"}>
          DOI, URL, arXiv ID or title
          <input
            className={fieldClass}
            required
            maxLength={2048}
            value={input}
            disabled={request.isPending}
            placeholder="https://doi.org/…"
            onChange={(e) => {
              setInput(e.target.value);
              setMatches(null);
              request.reset();
            }}
          />
        </label>
        <Button type="submit" disabled={!input.trim() || request.isPending}>
          {request.isPending && !matches ? "Finding…" : "Find"}
        </Button>
      </form>
      {request.error && (
        <p role="alert" className="text-sm text-destructive">
          {request.error.message}
        </p>
      )}
      {request.isPending && !matches && (
        <LoadingState compact label="Finding matches…" />
      )}
      {matches && !matches.length && (
        <EmptyState
          compact
          role="status"
          title="No matching papers. Try another title or identifier."
        />
      )}
      {matches?.map((match) => (
        <div
          key={match.query}
          className="flex flex-wrap items-center justify-between gap-4 rounded-md bg-control p-4"
        >
          <div className="min-w-0 flex-1 basis-64">
            <p className="text-xs font-medium text-subtle">
              Match via{" "}
              {match.source === "openalex"
                ? "OpenAlex"
                : match.source === "s2"
                  ? "Semantic Scholar"
                  : match.source === "crossref"
                    ? "Crossref"
                    : match.source}
            </p>
            <p className="mt-1 font-serif text-base font-semibold">
              <MathText text={match.title} />
            </p>
            {match.verified === false && <PageMetadataNotice />}
            <p className="mt-1 text-xs text-muted-foreground">
              {[
                match.authors.join(", "),
                match.venue,
                match.year,
                linkLabel(match.link),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={request.isPending}
              onClick={() =>
                request.mutate({ query: match.query, dry_run: false })
              }
            >
              Add to library
            </Button>
            <Button
              variant="ghost"
              disabled={request.isPending}
              onClick={() =>
                setMatches(
                  matches.length > 1
                    ? matches.filter((v) => v.query !== match.query)
                    : null,
                )
              }
            >
              Not this one
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
