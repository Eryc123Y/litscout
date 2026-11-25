import { useDeferredValue, useId, useState, type KeyboardEvent } from "react";
import { Markdown } from "./Markdown";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import { formatCount } from "./format";
import { cn } from "./lib/utils";

type Mode = "write" | "both" | "preview";

/** A small Markdown editor (tables, task lists, links, `$` math): by default
 * the textarea with a live preview under it, or beside it when there is
 * room; Write and Preview show one of the two. A length count,
 * Cmd/Ctrl+Enter to save and Escape to cancel. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  maxLength,
  rows = 8,
  placeholder = "Write in Markdown: lists, **bold**, links, tables.",
  onSave,
  onCancel,
  disabled,
  autoFocus,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  rows?: number;
  placeholder?: string;
  onSave?: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("both");
  // The preview trails the textarea, so typing never waits on rendering.
  const preview = useDeferredValue(value);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSave) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className={cn("flex flex-col gap-2", className)} onKeyDown={onKeyDown}>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium" htmlFor={id}>
          {label}
        </label>
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="Editor view"
          value={mode}
          onValueChange={(next) => next && setMode(next as Mode)}
        >
          <ToggleGroupItem value="write" className="px-2.5 text-xs">
            Write
          </ToggleGroupItem>
          <ToggleGroupItem value="both" className="px-2.5 text-xs">
            Both
          </ToggleGroupItem>
          <ToggleGroupItem value="preview" className="px-2.5 text-xs">
            Preview
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="@container">
        <div
          className={cn(
            "grid gap-2",
            mode === "both" && "@xl:grid-cols-2 @xl:items-stretch",
          )}
        >
          {/* The textarea stays mounted so its label always has a target. */}
          <textarea
            hidden={mode === "preview"}
            id={id}
            className="min-w-0 rounded-md border bg-background px-3 py-2 font-mono text-[13px] leading-relaxed"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={rows}
            maxLength={maxLength}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
          />
          {mode !== "write" && (
            <div
              role="region"
              aria-label="Preview"
              tabIndex={0}
              className="max-h-80 min-h-24 min-w-0 overflow-y-auto rounded-md border bg-background px-4 py-3 text-sm"
            >
              {preview.trim() ? (
                <Markdown gfm text={preview} />
              ) : (
                <p className="text-muted-foreground">Nothing to preview yet.</p>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="-mt-1 flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span>
          {[onSave && "Cmd or Ctrl + Enter saves", onCancel && "Esc cancels"]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span>
          {formatCount(value.length)} / {formatCount(maxLength)}
        </span>
      </p>
    </div>
  );
}
