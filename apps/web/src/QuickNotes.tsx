import { useId, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  notesPageSchema,
  quickNoteSchema,
  type QuickNote,
} from "@litscout/pipeline/library-contracts";
import { apiGet, apiMutation } from "./api";
import { Markdown } from "./Markdown";
import { QueryState } from "./Notice";
import { MarkdownEditor } from "./MarkdownEditor";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";

const maxNote = 4000;

/** What to ask an agent for, with the ids its LitScout tools need. */
export function noteRequest(paperId: string, title: string) {
  return `Add a LitScout note on the paper "${title}" (${paperId}): its key idea, how it bears on my projects, and what I should check in it.`;
}

export function QuickNotes({
  paperId,
  title,
}: {
  paperId: string;
  title: string;
}) {
  const titleId = useId();
  const [writing, setWriting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<QuickNote>();
  const [removing, setRemoving] = useState<string>();
  const client = useQueryClient();
  const queryKey = ["quick-notes", paperId];
  const notes = useInfiniteQuery({
    queryKey,
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({
        target: paperId,
        ...(pageParam ? { after: pageParam } : {}),
      });
      return apiGet("/notes?" + q, notesPageSchema, signal);
    },
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const mutation = useMutation({
    mutationFn: ({ note, remove }: { note?: QuickNote; remove?: boolean }) => {
      if (!note)
        return apiMutation(
          "/notes",
          "POST",
          { target: paperId, bodyMd: draft },
          quickNoteSchema,
        );
      return apiMutation(
        "/notes/" + encodeURIComponent(note.id),
        remove ? "DELETE" : "PATCH",
        {
          if_rev: note.rev,
          ...(remove ? {} : { bodyMd: draft }),
        },
        quickNoteSchema,
      );
    },
    onSuccess: async (_data, action) => {
      setRemoving(undefined);
      if (!action.remove || action.note?.id === editing?.id) {
        setDraft("");
        setEditing(undefined);
        setWriting(false);
      }
      await client.invalidateQueries({ queryKey });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey });
    },
  });
  const items = notes.data?.pages.flatMap((p) => p.items) ?? [];
  const closeEditor = () => {
    setWriting(false);
    setEditing(undefined);
    setDraft("");
    mutation.reset();
  };
  const save = () => {
    if (!draft.trim() || mutation.isPending) return;
    mutation.mutate({
      note: items.find((note) => note.id === editing?.id) ?? editing,
    });
  };
  const copyRequest = async (button: HTMLButtonElement) => {
    const text = noteRequest(paperId, title);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard refused: show the text selected so it can be copied.
      button.closest("section")?.querySelector("output")?.focus();
    }
  };
  const empty = (
    <section className="flex flex-col gap-2 text-sm">
      <p className="text-subtle">
        No notes yet. Ask Claude or Codex to add one through LitScout, or write
        one yourself.
      </p>
      <output
        tabIndex={-1}
        className="rounded-md bg-control px-3 py-2 text-xs text-subtle select-all"
      >
        {noteRequest(paperId, title)}
      </output>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={(event) => void copyRequest(event.currentTarget)}
        >
          Copy request
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {copied ? "Copied" : ""}
        </span>
      </div>
    </section>
  );
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle>
          <h2 id={titleId}>Quick notes</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {notes.isPending ? (
          // Most papers have no notes. The loader sits over a hidden copy of
          // the empty state, so the card keeps its height when the answer
          // comes.
          <div className="relative">
            <div
              data-slot="notes-reserve"
              aria-hidden="true"
              inert
              className="invisible"
            >
              {empty}
            </div>
            <div className="absolute inset-0">
              <QueryState
                query={notes}
                label="Loading notes…"
                errorTitle="Notes unavailable"
              />
            </div>
          </div>
        ) : notes.isError && !notes.data ? (
          <QueryState
            query={notes}
            label="Loading notes…"
            errorTitle="Notes unavailable"
          />
        ) : items.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {items.map((note) => (
              <li key={note.id} className="reader-row flex flex-col gap-2 px-3">
                <p className="text-xs text-muted-foreground">
                  {note.client ? <bdi>{note.client}</bdi> : "You"}
                </p>
                <Markdown gfm text={note.bodyMd} />
                <div className="-ml-2 flex flex-wrap gap-1">
                  {removing === note.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate({ note, remove: true })}
                      >
                        Confirm delete
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(undefined)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={mutation.isPending}
                        onClick={() => {
                          mutation.reset();
                          setEditing(note);
                          setDraft(note.bodyMd);
                          setWriting(true);
                        }}
                      >
                        <Pencil data-icon="inline-start" aria-hidden="true" />
                        Edit note
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={mutation.isPending}
                        onClick={() => setRemoving(note.id)}
                      >
                        <Trash2 data-icon="inline-start" aria-hidden="true" />
                        Delete note
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          empty
        )}
        {notes.hasNextPage && (
          <Button
            className="self-start"
            variant="outline"
            disabled={notes.isFetchingNextPage}
            onClick={() => void notes.fetchNextPage()}
          >
            {notes.isFetchingNextPage ? "Loading…" : "Load more notes"}
          </Button>
        )}
        {notes.isFetchNextPageError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load more notes.
          </p>
        )}
        {writing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <MarkdownEditor
              label="Note (Markdown)"
              value={draft}
              onChange={setDraft}
              maxLength={maxNote}
              rows={6}
              onSave={save}
              onCancel={closeEditor}
              disabled={mutation.isPending}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={!draft.trim() || mutation.isPending}
              >
                Save note
              </Button>
              <Button type="button" variant="ghost" onClick={closeEditor}>
                Cancel
              </Button>
            </div>
            {mutation.error && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error.message}
              </p>
            )}
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => {
              mutation.reset();
              setWriting(true);
            }}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add note
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
