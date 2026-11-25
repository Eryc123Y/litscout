import { useVaultInfo } from "./research-api";
import { Button } from "./components/ui/button";

export function ObsidianLink({
  path,
  children,
  action = false,
  title,
}: {
  path: string;
  children: string;
  action?: boolean;
  /** Shown on hover, for example the vault path. */
  title?: string;
}) {
  const { data } = useVaultInfo();
  if (!data) return null;
  const link = (
    <a
      className={
        action
          ? undefined
          : "text-sm font-medium text-primary underline-offset-4 hover:underline"
      }
      href={
        "obsidian://open?vault=" +
        encodeURIComponent(data.name) +
        "&file=" +
        encodeURIComponent(path)
      }
      title={title ?? "Opens " + path + " in the Obsidian app on this computer"}
    >
      {children}
    </a>
  );
  return action ? <Button asChild>{link}</Button> : link;
}
