import { useEffect, type ReactNode } from "react";
import { PageHeader } from "./PageHeader";
import { EmptyState, LoadingState, usePageAnnouncement } from "./ReaderState";
import { Button } from "./components/ui/button";

type Query = {
  isPending: boolean;
  error: Error | null;
  refetch: () => unknown;
};

export function Notice({
  query,
  title,
  description,
  label,
  errorTitle,
  actions,
}: {
  query: Query;
  title: string;
  description: string;
  label: string;
  errorTitle: string;
  actions?: ReactNode;
}) {
  const announce = usePageAnnouncement();
  const errorMessage = query.error?.message;
  const announcement = query.isPending
    ? label
    : [errorTitle, errorMessage].filter(Boolean).join(". ");
  useEffect(() => {
    announce?.(announcement);
  }, [announce, announcement]);

  return (
    <main id="main" className="reader-page">
      <PageHeader
        title={query.isPending ? title : errorTitle}
        description={description}
      />
      {query.isPending ? (
        <LoadingState label={label} />
      ) : (
        <EmptyState
          role="alert"
          live={!announce}
          title={errorMessage ?? errorTitle}
          actions={
            <>
              <Button variant="outline" onClick={() => query.refetch()}>
                Retry
              </Button>
              {actions}
            </>
          }
        />
      )}
    </main>
  );
}

export function QueryState({
  query,
  label,
  errorTitle,
  retryLabel = "Retry",
}: {
  query: Query;
  label: string;
  errorTitle: string;
  retryLabel?: string;
}) {
  return query.isPending ? (
    <LoadingState compact label={label} />
  ) : (
    <EmptyState
      compact
      role="alert"
      title={errorTitle}
      description={query.error?.message}
      actions={
        <Button variant="outline" onClick={() => query.refetch()}>
          {retryLabel}
        </Button>
      }
    />
  );
}
