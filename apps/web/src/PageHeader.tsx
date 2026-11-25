import type { ReactNode, Ref } from "react";
import { cn } from "./lib/utils";

export function PageHeader({
  title,
  description,
  context,
  metadata,
  actions,
  titleId,
  titleRef,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  context?: ReactNode;
  metadata?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  return (
    <header className={cn("reader-header", className)}>
      <div className="reader-header-copy">
        {context && <div className="reader-header-context">{context}</div>}
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className="reader-title"
        >
          {title}
        </h1>
        {description ? <p className="text-subtle">{description}</p> : null}
        {metadata && <div className="reader-header-context">{metadata}</div>}
      </div>
      {actions && <div className="reader-header-actions">{actions}</div>}
    </header>
  );
}
