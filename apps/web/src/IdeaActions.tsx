import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { useId, useState } from "react";
import { Lightbulb, Link2 } from "lucide-react";
import { z } from "zod";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import { apiMutation } from "./api";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  useIdeas,
  useRefreshResearch,
  useVaultPaper,
  useVaultRequest,
} from "./research-api";
import { useMutation } from "@tanstack/react-query";

const field =
  "min-h-9 w-full rounded-md border bg-background px-3 py-2 text-sm";
/** The capture body limit in the vault request contract. */
const maxBody = 10_000;

export function CaptureDialog({
  paperId,
  draft,
  primary = false,
}: {
  paperId?: string;
  primary?: boolean;
  draft?: { id: string; title: string; body: string; applying: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(draft?.body ?? "");
  const announce = usePageAnnouncement();
  const create = useVaultRequest();
  const refresh = useRefreshResearch();
  const edit = useMutation({
    mutationFn: (fields: { title: string; body: string }) =>
      apiMutation(
        "/vault/requests/" + draft!.id,
        "PATCH",
        fields,
        z.object({ edited: z.literal(true) }),
      ),
    onSuccess: refresh,
  });
  const mutation = draft ? edit : create;
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          mutation.reset();
          setBody(draft?.body ?? "");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant={!primary && (paperId || draft) ? "outline" : "default"}
          disabled={draft?.applying}
          aria-label={draft ? "Edit before sync: " + draft.title : undefined}
        >
          {!draft && <Lightbulb data-icon="inline-start" />}
          {draft ? "Edit before sync" : "Capture idea"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>{draft ? "Edit capture" : "Capture idea"}</DialogTitle>
        <DialogDescription>
          The next vault sync sends this to your Obsidian Inbox.
        </DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const fields = {
              title: String(form.get("title")).trim(),
              body,
            };
            if (!fields.title) return;
            const onSuccess = () => {
              setOpen(false);
              announce?.("Capture waiting for sync");
            };
            if (draft) edit.mutate(fields, { onSuccess });
            else
              create.mutate(
                { kind: "capture", ...fields, paperId },
                { onSuccess },
              );
          }}
        >
          <label className="text-sm font-medium" htmlFor={titleId}>
            Title
          </label>
          <input
            id={titleId}
            name="title"
            className={field}
            defaultValue={draft?.title}
            required
            maxLength={512}
          />
          <MarkdownEditor
            label="Note (Markdown, optional)"
            value={body}
            onChange={setBody}
            maxLength={maxBody}
            rows={12}
            placeholder={
              "# Heading\n\nWrite in Markdown: lists, **bold**, links, tables."
            }
          />
          {mutation.error && (
            <p role="alert" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}
          <Button
            className="justify-self-start"
            type="submit"
            disabled={mutation.isPending}
          >
            {draft ? "Save capture" : "Queue capture"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LinkIdeaDialog({ paperId }: { paperId: string }) {
  const [open, setOpen] = useState(false);
  const announce = usePageAnnouncement();
  const [targetNoteId, setTarget] = useState("");
  const list = useIdeas(open);
  const request = useVaultRequest();
  const options = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          request.reset();
          setTarget("");
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Link2 data-icon="inline-start" />
          Link to an idea
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Link to an idea</DialogTitle>
        <DialogDescription>
          The next vault sync adds this paper to the chosen idea.
        </DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (targetNoteId)
              request.mutate(
                { kind: "link_paper", targetNoteId, paperId },
                {
                  onSuccess: () => {
                    setOpen(false);
                    announce?.("Link waiting for sync");
                  },
                },
              );
          }}
        >
          <NativeSelect
            aria-label="Idea"
            value={targetNoteId}
            onChange={(event) => setTarget(event.currentTarget.value)}
            required
          >
            <NativeSelectOption value="">Choose an idea</NativeSelectOption>
            {options.map((idea) => (
              <NativeSelectOption key={idea.id} value={idea.id}>
                {idea.title}
                {idea.projectTitle ? " · " + idea.projectTitle : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {list.isPending && <LoadingState compact label="Loading ideas…" />}
          {!list.isPending && !list.error && !options.length && (
            <EmptyState
              compact
              title="No indexed ideas."
              description="Run sync after creating an idea note."
            />
          )}
          {(list.error || request.error) && (
            <p role="alert" className="text-sm text-destructive">
              {(list.error ?? request.error)?.message}
            </p>
          )}
          {list.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more ideas
            </Button>
          )}
          <Button
            className="justify-self-start"
            type="submit"
            disabled={!targetNoteId || request.isPending}
          >
            Queue link
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PaperIdeaActions({
  paperId,
  primary,
}: {
  paperId: string;
  primary: boolean;
}) {
  const { data } = useVaultPaper(paperId);
  const announce = usePageAnnouncement();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <CaptureDialog paperId={paperId} primary={primary} />
      <LinkIdeaDialog paperId={paperId} />
      {(data?.capturePending || data?.linkPending) && (
        <div
          className="flex basis-full flex-wrap gap-x-3 text-xs text-subtle"
          role={announce ? undefined : "status"}
        >
          {data.capturePending && <span>Capture waiting for sync</span>}
          {data.linkPending && <span>Link waiting for sync</span>}
        </div>
      )}
    </div>
  );
}
