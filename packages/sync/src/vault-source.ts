import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isScalar, isSeq } from "yaml";
import { minimatch } from "minimatch";
import {
  vaultTagLabel,
  vaultTagList,
  type LitScoutConfig,
} from "@litscout/core";
import {
  noteBodyLimit,
  conventionPathLimit,
  indexLimit,
  vaultNote,
  vaultPath,
  type SyncConventions,
  type VaultNote,
  type VaultIssue,
} from "@litscout/pipeline/vault-contracts";
import { hash, identifier, parseNote, VaultError } from "./vault-note";

export type VaultConfig = LitScoutConfig["vault"];
const maxNoteBytes = 2 * 1024 * 1024;
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const inspect = (file: string) =>
  lstat(file).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
const matches = (value: string, pattern: string) =>
  minimatch(
    value.normalize("NFC"),
    pattern.normalize("NFC").replace(/\/+$/, ""),
    {
      dot: true,
      nonegate: true,
      nocomment: true,
      nocase: true,
    },
  );
const sameFile = (a: Stats, b: Stats | null) =>
  b && a.dev === b.dev && a.ino === b.ino;
const isMarkdown = (file: string) => /\.md$/i.test(file);

type VaultExclusions = { excludedFolders: number; excludedNotes: number };

export interface VaultFiles {
  read(file: string): Promise<string | null>;
  files(dir?: string, exclusions?: VaultExclusions): AsyncIterable<string>;
  write(file: string, before: string | null, after: string): Promise<void>;
}

export async function openVault(
  config: VaultConfig,
  configDir = process.cwd(),
): Promise<VaultFiles> {
  const requestedRoot = path.resolve(configDir, config.root);
  const info = await inspect(requestedRoot);
  if (!info?.isDirectory())
    throw new VaultError(
      "Vault root must be an existing directory, without a symlink at the root.",
    );
  const rootInfo = info;
  const root = await realpath(requestedRoot);
  if (!sameFile(rootInfo, await inspect(root)))
    throw new VaultError("Vault root moved.");
  const excluded = (relative: string) =>
    config.exclude.some((glob) => matches(relative, glob));

  // Pin each parent as the working directory during synchronous mutations. If
  // it was swapped for a symlink after inspection, its path or inode differs.
  // No asynchronous operation runs while the process directory is changed.
  function inParent<T>(parent: string, expected: Stats, work: () => T): T {
    const previous = process.cwd();
    process.chdir(parent);
    try {
      if (process.cwd() !== parent || !sameFile(expected, lstatSync(".")))
        throw new VaultError("Vault file parent moved during sync.");
      return work();
    } finally {
      process.chdir(previous);
    }
  }

  async function check(relative: string, createParents = false) {
    const { success } = vaultPath.safeParse(relative);
    if (!success) throw new VaultError("Expected a path inside the vault.");
    if (
      !sameFile(rootInfo, await inspect(root)) ||
      (await realpath(root)) !== root
    )
      throw new VaultError("Vault root moved.");
    const parts = relative.split("/");
    let current = root,
      prefix = "",
      parentInfo = rootInfo;
    for (const [index, part] of parts.entries()) {
      prefix += (prefix ? "/" : "") + part;
      if (excluded(prefix))
        throw new VaultError("Path is excluded by vault.exclude.");
      current = path.join(current, part);
      const stat = await inspect(current);
      if (stat?.isDirectory() && excluded(prefix + "/"))
        throw new VaultError("Path is excluded by vault.exclude.");
      if (stat?.isSymbolicLink())
        throw new VaultError("Vault paths cannot traverse symlinks.");
      if (index === parts.length - 1) return { file: current, stat };
      if (stat && !stat.isDirectory())
        throw new VaultError("Vault path parent must be a directory.");
      if (!stat && createParents)
        inParent(path.dirname(current), parentInfo, () => {
          try {
            mkdirSync(part, { mode: 0o755 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        });
      if (stat || createParents) {
        const latest = await inspect(current);
        if (!latest?.isDirectory())
          throw new VaultError("Vault paths cannot traverse symlinks.");
        parentInfo = latest;
      }
      // Resolve each ancestor before moving on, including freshly made directories.
      if ((stat || createParents) && (await realpath(current)) !== current)
        throw new VaultError("Vault paths cannot traverse symlinks.");
    }
    throw new VaultError("Expected a path inside the vault.");
  }

  async function read(relative: string) {
    const { file, stat } = await check(relative);
    if (!stat) return null;
    if (!stat.isFile() || stat.size > maxNoteBytes)
      throw new VaultError("Expected a vault file no larger than 2 MiB.");
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (
        !sameFile(stat, await handle.stat()) ||
        !sameFile(stat, (await check(relative)).stat)
      )
        throw new VaultError("Vault file moved during sync.");
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead !== stat.size)
        throw new VaultError("Vault file changed during sync.");
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer.subarray(0, result.bytesRead));
      } catch {
        throw new VaultError("Expected a UTF-8 Markdown file.");
      }
    } finally {
      await handle.close();
    }
  }

  async function* files(
    dir = "",
    exclusions?: VaultExclusions,
    strict = Boolean(dir),
  ): AsyncIterable<string> {
    const directory = dir
      ? await check(dir)
      : { file: root, stat: await inspect(root) };
    if (!dir && !sameFile(rootInfo, directory.stat))
      throw new VaultError("Vault root moved.");
    if (!directory.stat) return;
    if (
      !directory.stat.isDirectory() ||
      (await realpath(directory.file)) !== directory.file
    )
      throw new VaultError("Expected a directory inside the vault.");
    const entries = await readdir(directory.file, { withFileTypes: true });
    for (const item of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = dir ? dir + "/" + item.name : item.name;
      const isDirectory = item.isDirectory();
      if (excluded(relative) || (isDirectory && excluded(relative + "/"))) {
        if (exclusions) {
          if (isDirectory) exclusions.excludedFolders++;
          else if (item.isFile() && isMarkdown(item.name))
            exclusions.excludedNotes++;
        }
        continue;
      }
      if (isDirectory && vaultPath.safeParse(relative).success)
        yield* files(relative, exclusions, strict);
      else if (item.isFile() || isDirectory || strict) yield relative;
    }
    if (!dir && !sameFile(rootInfo, await inspect(root)))
      throw new VaultError("Vault root moved.");
  }

  return {
    read,
    files,
    async write(relative, before, after) {
      if (!config.write) throw new VaultError("Vault writes are off.");
      if ((await read(relative)) !== before)
        throw new VaultError("Vault file changed during sync.");
      const { file, stat } = await check(relative, true);
      const parentPath = path.dirname(file);
      const parent = await inspect(parentPath);
      if (!parent?.isDirectory() || (await realpath(parentPath)) !== parentPath)
        throw new VaultError("Vault file parent moved during sync.");
      inParent(parentPath, parent, () => {
        const name = path.basename(file);
        if (before !== null) {
          if (!stat) throw new VaultError("Vault file changed during sync.");
          const current = openSync(
            name,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            if (!Buffer.from(before).equals(readFileSync(current)))
              throw new VaultError("Vault file changed during sync.");
          } finally {
            closeSync(current);
          }
        }
        const temporary = ".litscout-" + crypto.randomUUID() + ".tmp";
        const fd = openSync(temporary, "wx", stat ? stat.mode & 0o777 : 0o600);
        try {
          if (stat) fchmodSync(fd, stat.mode & 0o777);
          writeFileSync(fd, after, "utf8");
          fsyncSync(fd);
          const latest = lstatSync(name, { throwIfNoEntry: false });
          if (
            stat &&
            (!latest ||
              !sameFile(stat, latest) ||
              stat.mtimeMs !== latest.mtimeMs ||
              stat.ctimeMs !== latest.ctimeMs ||
              stat.size !== latest.size)
          )
            throw new VaultError("Vault file changed during sync.");
          if (process.cwd() !== parentPath)
            throw new VaultError("Vault file parent moved during sync.");
          if (before === null) linkSync(temporary, name);
          else {
            if (!stat) throw new VaultError("Vault file changed during sync.");
            renameSync(temporary, name);
          }
        } finally {
          closeSync(fd);
          try {
            unlinkSync(temporary);
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      });
    },
  };
}

export type VaultTagCounts = {
  idea: Record<string, number>;
  workingPaper: Record<string, number>;
};

export interface VaultSource {
  index(options?: { conventionsOnly?: boolean }): Promise<
    {
      notes: VaultNote[];
      issues: VaultIssue[];
      conventions: SyncConventions;
      /** Notes per configured tag, for previews; never uploaded. */
      tagCounts?: VaultTagCounts;
    } & VaultExclusions
  >;
}

const string = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => Boolean(string(item)))
    : string(value)
      ? [value as string]
      : undefined;
function readIdentifier(value: unknown, kind: "doi" | "arxiv") {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const id = identifier(String(value));
  return id?.kind === kind ? id.value : undefined;
}

function resolvePaperReferences(notes: VaultNote[]) {
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, string | null>();
  for (const note of notes) {
    if (note.kind !== "paper_note") continue;
    const id = note.frontmatter.arxiv ?? note.frontmatter.doi;
    if (!id) continue;
    const name = note.path.replace(/\.md$/i, "");
    byPath.set(name.toLowerCase(), id);
    for (const title of new Set([
      note.title.toLowerCase(),
      path.posix.basename(name).toLowerCase(),
    ])) {
      const previous = byTitle.get(title);
      byTitle.set(title, previous === undefined || previous === id ? id : null);
    }
  }
  return notes.map((note) => {
    if (
      (note.kind !== "idea" && note.kind !== "working_paper") ||
      !note.frontmatter.papers
    )
      return note;
    const papers = note.frontmatter.papers.map((entry) => {
      const id = identifier(entry);
      if (id) return id.value;
      if (!entry.startsWith("[[") || !entry.endsWith("]]")) return entry;
      const ref = entry
        .slice(2, -2)
        .split(/[|#]/, 1)[0]!
        .trim()
        .replace(/\.md$/i, "")
        .toLowerCase();
      return byPath.get(ref) ?? byTitle.get(ref) ?? entry;
    });
    return {
      ...note,
      frontmatter: { ...note.frontmatter, papers: [...new Set(papers)] },
    };
  });
}

// Templater placeholders on one line (`<% tp.date.now() %>`), and the core
// Templates variables (`{{date}}`, `{{time}}`, `{{title}}`, with an optional
// format). BibTeX `{{BERT}}` or LaTeX `\frac{{a}}{b}` in a title is not one.
const templatePlaceholder =
  /<%[^\n]*?%>|\{\{\s*(?:date|time|title)(?::[^{}\n]*)?\s*\}\}/i;
// Read from the raw header, because a template's YAML may not parse.
const privateHeader = /^\s*litscout\s*:\s*["']?\s*private\s*["']?\s*$/im;

function vaultHeader(text: string) {
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!open) return "";
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  return rest.slice(0, close?.index);
}

// Escapes and aliases can spell a tag indirectly. Let the YAML parser decide.
function mayHaveVaultTag(header: string, tags: readonly string[]): boolean {
  if (
    !/(?:^[ \t]*|[,{][ \t]*)(?:tags|'tags'|"tags"|"[^"\n]*\\[^"\n]*")[ \t]*:/m.test(
      header,
    )
  )
    return false;
  const lower = header.toLowerCase();
  return tags.some((tag) => lower.includes(tag)) || /[\\*]/.test(header);
}

const continues = "\n\n*Continues in the vault.*";

/** What the web may show of a note body. Obsidian %%comments%% and HTML
 * comments are hidden in reading view, so they stay local. A long body is
 * cut at the upload limit with a pointer to the rest. */
export function shareableBody(body: string) {
  const shown = body
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (shown.length <= noteBodyLimit) return shown;
  const cut = shown.slice(0, noteBodyLimit - continues.length);
  // Never end on half of a surrogate pair.
  return (
    (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut).trimEnd() +
    continues
  );
}

export function localVaultSource(
  vault: VaultFiles,
  config: VaultConfig,
): VaultSource {
  const tagName = (tag: string) => tag.replace(/^#/, "").toLowerCase();
  const ideaTags = vaultTagList(config.ideaTag);
  const workingPaperTags = vaultTagList(config.workingPaperTag);
  const wanted = [...ideaTags, ...workingPaperTags, "type/paper"];
  const zero = (tags: string[]) =>
    Object.fromEntries(tags.map((tag) => [tag, 0]));
  return {
    async index({ conventionsOnly = false } = {}) {
      const notes: VaultNote[] = [],
        issues: VaultIssue[] = [];
      const exclusions = { excludedFolders: 0, excludedNotes: 0 };
      const tagCounts: VaultTagCounts = {
        idea: zero(ideaTags),
        workingPaper: zero(workingPaperTags),
      };
      const templates = { count: 0, paths: [] as string[] };
      const conventions: Omit<SyncConventions, keyof VaultExclusions> = {
        ideaTag: vaultTagLabel(config.ideaTag),
        ideaNotes: 0,
        workingPaperTag: vaultTagLabel(config.workingPaperTag),
        workingPaperNotes: 0,
        paperNotesWithoutIdentifiers: { count: 0, paths: [] },
        possibleNonProjects: 0,
        privateNotes: 0,
      };
      for await (const file of vault.files(undefined, exclusions)) {
        let reportIssue = true;
        try {
          if (!vaultPath.safeParse(file).success)
            throw new VaultError("Expected a path inside the vault.");
          if (!isMarkdown(file)) continue;
          const projectPath = config.projects.some((glob) =>
            matches(file, glob),
          );
          const briefPath = config.briefs.some((glob) => matches(file, glob));
          const text = await vault.read(file);
          if (text === null)
            throw new VaultError("The file disappeared during indexing.");
          const header = vaultHeader(text);
          reportIssue =
            projectPath || briefPath || mayHaveVaultTag(header, wanted);
          // A template is not a note of any kind; count it so it stays visible.
          // Notes under the project or brief paths are never templates.
          if (
            reportIssue &&
            !projectPath &&
            !briefPath &&
            templatePlaceholder.test(header)
          ) {
            if (privateHeader.test(header)) conventions.privateNotes++;
            else {
              templates.count++;
              if (templates.paths.length < conventionPathLimit)
                templates.paths.push(file);
            }
            continue;
          }
          if (!reportIssue && !/litscout|\\/.test(header)) continue;
          const { doc, body } = parseNote(text);
          const privacy = doc.get("litscout");
          if (
            typeof privacy === "string" &&
            privacy.trim().toLowerCase() === "private"
          ) {
            conventions.privateNotes++;
            continue;
          }
          if (!reportIssue) continue;
          const value = (key: string): unknown => doc.get(key);
          const yamlList = (key: string) => {
            const node = doc.get(key, true);
            return list(
              isSeq(node)
                ? node.items.map((item) =>
                    isScalar(item) ? item.value : undefined,
                  )
                : value(key),
            );
          };
          const tags = new Set(
            yamlList("tags")?.flatMap((tag) =>
              tag
                .split(/[,\s]+/)
                .map((item) => item.replace(/^#/, "").toLowerCase()),
            ) ?? [],
          );
          const hasTag = (tag: string) => tags.has(tagName(tag));
          const ideaHits = ideaTags.filter((tag) => tags.has(tag));
          const workingPaperHits = workingPaperTags.filter((tag) =>
            tags.has(tag),
          );
          for (const tag of ideaHits) tagCounts.idea[tag]!++;
          for (const tag of workingPaperHits) tagCounts.workingPaper[tag]!++;
          const idea = ideaHits.length > 0;
          const workingPaper = workingPaperHits.length > 0;
          const paper = hasTag("type/paper");
          if (idea) conventions.ideaNotes++;
          if (workingPaper) conventions.workingPaperNotes++;
          if (
            projectPath &&
            string(value("type"))?.trim().toLowerCase() !== "project" &&
            !hasTag("type/project") &&
            !hasTag("project")
          )
            conventions.possibleNonProjects++;
          const arxivNode = doc.get("arxiv", true);
          const arxiv = readIdentifier(
            isScalar(arxivNode) && typeof arxivNode.value === "number"
              ? arxivNode.source
              : value("arxiv"),
            "arxiv",
          );
          const doi = readIdentifier(value("doi"), "doi");
          if (paper && !arxiv && !doi) {
            const missing = conventions.paperNotesWithoutIdentifiers;
            missing.count++;
            if (missing.paths.length < conventionPathLimit)
              missing.paths.push(file);
          }
          if (conventionsOnly) continue;
          if (!projectPath && idea && workingPaper)
            throw new VaultError(
              "The note has both an idea tag and a working-paper tag. Keep one kind.",
            );
          const status = string(value("status")),
            description = config.uploadDescriptions
              ? string(value("description"))
              : undefined,
            project = string(value("project")),
            papers = yamlList("papers");
          const item = projectPath
            ? { kind: "project", frontmatter: { status, description } }
            : idea
              ? {
                  kind: "idea",
                  frontmatter: { status, description, project, papers },
                }
              : workingPaper
                ? {
                    kind: "working_paper",
                    frontmatter: {
                      status,
                      project,
                      papers,
                      ideas: yamlList("ideas"),
                    },
                  }
                : paper &&
                    (arxiv || doi || (!doc.has("arxiv") && !doc.has("doi")))
                  ? {
                      kind: "paper_note",
                      frontmatter: {
                        arxiv,
                        doi,
                        maturity: string(value("maturity")),
                      },
                    }
                  : briefPath
                    ? { kind: "brief", frontmatter: {} }
                    : null;
          if (!item) continue;
          // Read-only bodies for the web, only when configured and allowed.
          const shown = shareableBody(body);
          const shareBody =
            config.uploadBodies &&
            (item.kind === "project" ||
              item.kind === "idea" ||
              item.kind === "working_paper") &&
            shown.length > 0 &&
            !config.bodyExclude.some((glob) => matches(file, glob));
          notes.push(
            vaultNote.parse({
              id: hash(file),
              path: file,
              ...(shareBody ? { body: shown } : {}),
              title:
                string(value("title")) ??
                path.posix.basename(file).replace(/\.md$/i, ""),
              hash: hash(text),
              bodyHash: hash(body),
              ...item,
            }),
          );
        } catch (error) {
          if (conventionsOnly || !reportIssue) continue;
          const reason =
            error instanceof VaultError
              ? error.message
              : error instanceof Error && error.name === "ZodError"
                ? "Index fields exceed the allowed limits."
                : "Could not read the vault file.";
          issues.push({
            path: file.replace(/\p{Cc}/gu, "�").slice(0, 1024),
            reason,
          });
        }
        if (notes.length > indexLimit)
          throw new VaultError(
            "Vault index exceeds " +
              indexLimit +
              " notes. Narrow the vault selection.",
          );
      }
      return {
        notes: resolvePaperReferences(notes).sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
        issues,
        ...exclusions,
        // Only when there are some, so an older Worker's strict report accepts it.
        conventions: {
          ...conventions,
          ...exclusions,
          ...(templates.count > 0 ? { templates } : {}),
        },
        tagCounts,
      };
    },
  };
}
