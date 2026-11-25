import { useQuery } from "@tanstack/react-query";
import { vaultNoteView } from "@litscout/pipeline/vault-contracts";
import { apiGet } from "./api";
import { Markdown } from "./Markdown";

/** A project, idea or draft note, read-only. Obsidian stays the editor. */
export function useVaultNote(id: string, enabled = true) {
  return useQuery({
    queryKey: ["vault", "note", id],
    queryFn: ({ signal }) =>
      apiGet(
        "/vault/notes/" + encodeURIComponent(id),
        vaultNoteView.nullable(),
        signal,
      ),
    enabled,
    staleTime: 60_000,
  });
}

export function NoteBody({ id }: { id: string }) {
  const query = useVaultNote(id);
  if (query.isPending)
    return <p className="text-sm text-subtle">Loading note…</p>;
  if (query.isError)
    return (
      <p className="text-sm text-destructive">
        The note could not be loaded. Check the connection and open it again.
      </p>
    );
  if (!query.data)
    return (
      <p className="text-sm text-subtle">
        This note is no longer in the index. The next vault sync updates the
        list.
      </p>
    );
  if (query.data.bodyMd === null)
    return (
      <p className="text-sm text-subtle">
        This note’s text stays in your vault: body upload is off or the note is
        excluded. Open it in Obsidian to read it.
      </p>
    );
  return (
    <Markdown
      gfm
      text={obsidianMarkdown(withoutTitle(query.data.bodyMd, query.data.title))}
    />
  );
}

/** Notes often open with their own title as a heading; every reader shows
 * the title already, so a first heading that repeats it is dropped. */
export function withoutTitle(body: string, title: string) {
  const first =
    /^(?:[ \t]*\r?\n)*[ ]{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(
      body,
    );
  const plain = (text: string) =>
    text.replace(/[*_]/g, "").trim().toLowerCase();
  return first && plain(first[1]!) === plain(title)
    ? body.slice(first[0].length).replace(/^\s+/, "")
    : body;
}

const noteName = (target: string) =>
  target.split("#")[0]!.split("/").pop()!.replace(/\.md$/, "") || target;

/** Obsidian links point into the vault, which the web cannot open: show
 * [[Note|alias]] as its alias, [[Folder/Note#Part]] as "Note", and an
 * embed as the embedded note's name in italics. */
export function obsidianMarkdown(text: string) {
  // Odd parts are fenced blocks or inline code, which keep their brackets.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => (index % 2 ? part : plainLinks(part)))
    .join("");
}

function plainLinks(text: string) {
  return text
    .replace(
      /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
      (_, target: string) => "*" + noteName(target) + "*",
    )
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target: string, alias?: string) => alias ?? noteName(target),
    );
}
