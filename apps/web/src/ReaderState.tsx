import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { cn } from "./lib/utils";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./components/ui/empty";
import { Skeleton } from "./components/ui/skeleton";

const PageAnnouncement = createContext<((text: string) => void) | null>(null);

export function PageAnnouncements({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState({ text: "", sequence: 0 });
  const announce = useCallback((text: string) => {
    setMessage((previous) => ({ text, sequence: previous.sequence + 1 }));
  }, []);
  return (
    <PageAnnouncement value={announce}>
      {children}
      <div role="status" aria-label="Page updates" className="sr-only">
        <span key={message.sequence}>{message.text}</span>
      </div>
    </PageAnnouncement>
  );
}

export function usePageAnnouncement() {
  return useContext(PageAnnouncement);
}

export function EmptyState({
  title,
  description,
  actions,
  role,
  live = true,
  compact,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  role?: "status" | "alert";
  live?: boolean;
  compact?: boolean;
}) {
  return (
    <Empty
      role={live ? role : undefined}
      className={cn(
        "items-start gap-3 p-5 text-left text-wrap md:p-6",
        compact && "flex-none justify-start gap-2 p-0 md:p-0",
      )}
    >
      <EmptyHeader className="max-w-none items-start gap-1 text-left">
        <EmptyTitle
          className={cn(
            "text-body font-semibold tracking-normal",
            compact && "text-sm font-normal text-subtle",
            role === "alert" && "text-destructive",
          )}
        >
          {title}
        </EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </Empty>
  );
}

export function LoadingState({
  label,
  compact,
  live = true,
}: {
  label: string;
  compact?: boolean;
  live?: boolean;
}) {
  const announce = usePageAnnouncement();
  return (
    <div
      role={live && !announce ? "status" : undefined}
      className={cn(
        // style.css holds it back 200 ms, so a fast answer shows no loader.
        "loading-state grid gap-3 text-sm text-muted-foreground",
        compact ? "gap-2" : "reader-panel",
      )}
    >
      <span>{label}</span>
      <div aria-hidden="true" className="grid gap-2">
        <Skeleton className="h-3 w-2/3" />
        {!compact && <Skeleton className="h-3 w-2/5" />}
      </div>
    </div>
  );
}
