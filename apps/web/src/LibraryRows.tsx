import { useEffect, useId, useRef, useState } from "react";
import { PanelLink } from "./SidePanel";
import { useMenuPopover } from "./menu-popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  libraryItemSchema,
  libraryStatus,
  type LibraryRow,
} from "@litscout/pipeline/library-contracts";
import { EllipsisVertical } from "lucide-react";
import { apiMutation } from "./api";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { PageMetadataNotice } from "./PageMetadataNotice";
import { safeUrl } from "./model";
import { MathText, plainMath } from "./math-text";
import { fieldClass, statusLabels } from "./library-ui";

export function linkLabel(link: LibraryRow["link"]) {
  if (!link) return undefined;
  if (link.kind === "pdf_oa" || link.kind === "pdf_arxiv") return "Read PDF";
  return "Publisher page";
}

export function AlphaXivLink({ url }: { url: string }) {
  const href = safeUrl(url);
  return href ? (
    <a
      className="text-primary hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open in alphaXiv
    </a>
  ) : null;
}

export function SavedRow({
  item,
  compact = false,
}: {
  item: LibraryRow;
  /** Beside the side panel: no venue or origin columns. */
  compact?: boolean;
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const row = useRef<HTMLTableRowElement>(null);
  const actions = useRef<HTMLButtonElement>(null);
  const tagsField = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  // Each inline form takes focus when it opens from the row menu.
  useEffect(() => {
    if (editing) tagsField.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (removing) confirm.current?.focus();
  }, [removing]);
  /** Close the inline forms; focus inside them goes back to the menu. */
  const closeForms = () => {
    const active = document.activeElement;
    setEditing(false);
    setRemoving(false);
    if (!active || active === document.body || row.current?.contains(active))
      actions.current?.focus();
  };
  const editable = item.rev !== null;
  const path = "/library/" + encodeURIComponent(item.paperId);
  const mutation = useMutation({
    mutationFn: (edit: { status?: string; tags?: string[] } | null) =>
      apiMutation(
        path,
        edit ? "PATCH" : "DELETE",
        { ...edit, if_rev: item.rev },
        libraryItemSchema,
      ),
    onSuccess: async () => {
      closeForms();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["library"] }),
        client.invalidateQueries({ queryKey: ["reading-state", item.paperId] }),
      ]);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const url = safeUrl(item.link?.url);
  return (
    <tr ref={row} role="row" className="align-top hover:bg-control/60">
      <td role="cell" className="px-4 py-3">
        <div className="contents max-md:flex max-md:items-start">
          <PanelLink
            className="reader-record-link"
            target={{ kind: "paper", id: item.paperId }}
          >
            <MathText text={item.title} />
          </PanelLink>
        </div>
        {item.verified === false && <PageMetadataNotice />}
        <p className="text-xs text-muted-foreground">
          {item.authors.map((a) => a.name).join(", ")}
        </p>
        {item.tags.length > 0 && (
          <p className="mt-1 text-xs text-subtle">{item.tags.join(", ")}</p>
        )}
        {editing ? (
          <form
            className="mt-2 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const tags = String(new FormData(e.currentTarget).get("tags"))
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean);
              mutation.mutate({ tags });
            }}
          >
            <input
              ref={tagsField}
              className={fieldClass}
              name="tags"
              aria-label="Comma-separated tags"
              defaultValue={item.tags.join(", ")}
            />
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              Save tags
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeForms}
            >
              Cancel
            </Button>
          </form>
        ) : null}
        {mutation.error && (
          <p role="alert" className="text-xs text-destructive">
            {mutation.error.message}
          </p>
        )}
      </td>
      {compact ? null : (
        <>
          <td role="cell" className="px-4 py-3 text-subtle">
            {[item.venue, item.year].filter(Boolean).join(" · ") || "—"}
          </td>
          <td role="cell" className="px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {item.origin.map((origin) => (
                <Badge key={origin} variant="secondary">
                  {origin === "litscout" ? "LitScout" : "alphaXiv"}
                </Badge>
              ))}
            </div>
            {!!item.alphaXiv?.folders.length && (
              <ul className="mt-1 space-y-0.5 text-xs text-subtle">
                {item.alphaXiv.folders.map(({ id, path }) => (
                  <li key={id}>{path}</li>
                ))}
              </ul>
            )}
          </td>
        </>
      )}
      <td role="cell" className="library-status px-4 py-3">
        {editable ? (
          <>
            <select
              aria-label={"Status for " + plainMath(item.title)}
              className={fieldClass + " min-h-8 bg-control py-1 pr-7"}
              // Not disabled while saving, so keyboard focus stays here.
              aria-busy={mutation.isPending}
              value={item.status}
              onChange={(e) => {
                if (!mutation.isPending)
                  mutation.mutate({ status: e.target.value });
              }}
            >
              {libraryStatus.options.map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
            <div className="mt-1 flex flex-wrap gap-1 max-md:mt-0">
              {removing ? (
                <>
                  <Button
                    ref={confirm}
                    variant="destructive"
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate(null)}
                  >
                    Confirm remove
                  </Button>
                  <Button variant="ghost" size="sm" onClick={closeForms}>
                    Cancel
                  </Button>
                </>
              ) : null}
            </div>
          </>
        ) : (
          <span>{statusLabels[item.status]}</span>
        )}
        {item.alphaXiv && item.alphaXiv.status !== item.status && (
          <p className="text-xs text-subtle">
            {statusLabels[item.alphaXiv.status]} on alphaXiv
          </p>
        )}
      </td>
      <td role="cell" className="px-4 py-3 whitespace-nowrap">
        {url ? (
          <a
            className="text-primary hover:underline"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkLabel(item.link)}
          </a>
        ) : !item.alphaXiv ? (
          <span className="text-muted-foreground">No link</span>
        ) : null}
        {item.alphaXiv && (
          <div className={url ? "mt-1" : undefined}>
            <AlphaXivLink url={item.alphaXiv.url} />
            {item.alphaXiv.hasNotes && (
              <p className="text-xs text-subtle">Has notes</p>
            )}
            {item.alphaXiv.highlightCount > 0 && (
              <p className="text-xs text-subtle">
                {item.alphaXiv.highlightCount}{" "}
                {item.alphaXiv.highlightCount === 1
                  ? "highlight"
                  : "highlights"}
              </p>
            )}
          </div>
        )}
      </td>
      <td role="cell" className="px-2 py-2.5 text-right">
        {editable && (
          <RowMenu
            triggerRef={actions}
            title={plainMath(item.title)}
            onEditTags={() => setEditing(true)}
            onRemove={() => setRemoving(true)}
          />
        )}
      </td>
    </tr>
  );
}

/** Row actions in one menu; Remove still asks for confirmation in the row. */
function RowMenu({
  triggerRef,
  title,
  onEditTags,
  onRemove,
}: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  title: string;
  onEditTags: () => void;
  onRemove: () => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu);
  const choose = (action: () => void) => () => {
    menu.current?.hidePopover?.();
    action();
  };
  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-subtle max-md:size-11"
        aria-label={"Actions for " + title}
        popoverTarget={id}
      >
        <EllipsisVertical aria-hidden="true" />
      </Button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="group"
        aria-label={"Actions for " + title}
        className="row-menu m-0 w-52 flex-col rounded-md border bg-card p-1.5 text-left text-sm text-foreground shadow-lg [&:popover-open]:flex"
      >
        <Button
          type="button"
          variant="ghost"
          className="justify-start"
          onClick={choose(onEditTags)}
        >
          Edit tags
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="justify-start text-destructive"
          onClick={choose(onRemove)}
        >
          Remove from library…
        </Button>
      </div>
    </>
  );
}
