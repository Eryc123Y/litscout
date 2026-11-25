import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { alphaXivSnapshot } from "@litscout/sync/alphaxiv";
import { agentProcess } from "./agent-process";
import { UsageError, type CommandResult } from "./command-types";
import { nowFor, type FlowDeps } from "./flow-runtime";

/** The only tools the capture agent may call: alphaXiv's two read tools. */
const tools = {
  library: "mcp__claude_ai_alphaXiv__list_library",
  annotated: "mcp__claude_ai_alphaXiv__list_annotated_papers",
};
const prompt =
  `Call ${tools.library} once with include_papers set to true. ` +
  `Then call ${tools.annotated} with page 1, and call the next page while a page lists 25 papers. ` +
  "Do not call any other tool and do not summarise the results. Then reply with the single word DONE.";
const noNotes = /has no notes or highlights/i;
const timeoutMs = 5 * 60_000;

const libraryResult = z.object({
  folders: z.array(
    z.object({
      folder_id: z.string(),
      name: z.string(),
      type: z.string(),
      parent_id: z.string().nullable(),
      paper_count: z.number().int().nonnegative(),
      papers: z
        .array(
          z.object({
            universal_paper_id: z.string(),
            title: z.string(),
            type: z.enum(["public", "private"]),
            publication_date: z.string().nullable().optional(),
          }),
        )
        .default([]),
    }),
  ),
});
const annotatedRow = z.looseObject({
  paper_id: z.string().optional(),
  universal_paper_id: z.string().optional(),
  type: z.string().optional(),
  highlight_count: z.number().int().nonnegative().default(0),
  has_notes: z.boolean().default(false),
  last_annotated_at: z.string(),
});
type Snapshot = z.input<typeof alphaXivSnapshot>;
type Annotation = {
  paperId: string;
  highlightCount: number;
  hasNotes: boolean;
  lastAnnotatedAt: string;
};

/** Claude Code's stream-json events, keeping only the alphaXiv tool calls
 * and their raw results in order. */
function toolResults(stdout: string) {
  const names = new Map<string, string>();
  const results: { name: string; text: string }[] = [];
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = (event as { message?: { content?: unknown } })?.message
      ?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "tool_use" && typeof block.id === "string")
        names.set(block.id, String(block.name));
      if (block.type === "tool_result") {
        const name = names.get(String(block.tool_use_id));
        if (!name) continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as { text?: string }[])
                  .map((part) => part.text ?? "")
                  .join("")
              : "";
        results.push({ name, text });
      }
    }
  }
  return results;
}

/** A tool result's text, or the file Claude Code saved a large one to. The
 * file must lie in the agent's own ~/.claude. Once read, the file and, when
 * it sits in a session's tool-results folder, that session (its folder and
 * transcript) are removed: the capture keeps its session only so the file
 * survives Claude Code's exit. */
async function resultText(text: string, home: string) {
  if (/^\s*[[{]/.test(text)) return text;
  // Claude Code words this differently across versions: "<persisted-output>
  // ... Full output saved to: PATH" or "... Output has been saved to PATH."
  const saved = /saved to:?\s+(\S+)/i.exec(text)?.[1]?.replace(/[.,;)]+$/, "");
  if (!saved) return text;
  const own = path.join(home, ".claude") + path.sep;
  const file = path.resolve(saved);
  if (!file.startsWith(own))
    throw new UsageError(
      `The capture agent saved a result outside ${own}; nothing was imported.`,
    );
  const body = await readFile(file, "utf8").catch(() => {
    throw new UsageError(
      "Claude Code did not keep the result it saved; nothing was imported.",
    );
  });
  await rm(file, { force: true });
  const session =
    /^(.*[\\/]projects[\\/][^\\/]+[\\/][0-9a-f-]{36})[\\/]tool-results[\\/]/i.exec(
      file,
    )?.[1];
  if (session) {
    await rm(session, { recursive: true, force: true });
    await rm(session + ".jsonl", { force: true });
  }
  return body;
}

function annotations(texts: string[]): Annotation[] | null {
  const rows = [];
  for (const text of texts) {
    if (noNotes.test(text)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed as object).find(Array.isArray);
    const page = z.array(annotatedRow).safeParse(list ?? []);
    if (!page.success) return null;
    rows.push(...page.data);
  }
  return rows
    .filter((row) => row.type !== "private")
    .map((row) => ({
      paperId: (row.paper_id ?? row.universal_paper_id)!,
      highlightCount: row.highlight_count,
      hasNotes: row.has_notes,
      lastAnnotatedAt: row.last_annotated_at,
    }))
    .filter((row) => row.paperId);
}

function snapshotFrom(
  library: z.output<typeof libraryResult>,
  takenAt: string,
  annotated: Annotation[],
): Snapshot {
  return {
    takenAt,
    folders: library.folders.map((folder) => ({
      id: folder.folder_id,
      name: folder.name,
      type: folder.type,
      parentId: folder.parent_id,
      paperCount: folder.paper_count,
      complete: folder.papers.length === folder.paper_count,
    })),
    memberships: library.folders.flatMap((folder) =>
      folder.papers.map((paper) => ({
        folderId: folder.folder_id,
        paperId: paper.universal_paper_id,
        paperType: paper.type,
        title: paper.title,
        publicationDate: paper.publication_date ?? null,
      })),
    ),
    annotations: annotated,
  } as Snapshot;
}

async function privateJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Claude Code with only alphaXiv's two read tools. The session is kept
 * (no --no-session-persistence): a large result lives in its tool-results
 * folder, which Claude Code would otherwise delete on exit. */
export function captureArgv() {
  return [
    "claude",
    "-p",
    "--model",
    "haiku",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    `${tools.library},${tools.annotated}`,
  ];
}

export type CaptureOptions = { import: boolean; dir: string };
type ImportSnapshot = (file: string) => Promise<CommandResult>;

/** `alphaxiv capture [--import]`: capture the alphaXiv library through the
 * configured agent and, with --import, mirror it (alphaxiv import). The
 * snapshot is kept in DIR as alphaxiv-pending.json and becomes
 * alphaxiv-last.json once imported. */
export async function alphaXivCapture(
  options: CaptureOptions,
  deps: FlowDeps,
  config: LitScoutConfig,
  {
    home = homedir(),
    importSnapshot,
  }: { home?: string; importSnapshot?: ImportSnapshot } = {},
): Promise<CommandResult> {
  if (config.library.alphaxivCapture === "none")
    return { data: { status: "off" }, empty: true };
  // The snapshot's time is taken before the library is read.
  const takenAt = nowFor(deps).toISOString();
  const run =
    deps.flow?.capture ??
    ((input: string) => agentProcess(captureArgv(), timeoutMs, input));
  const answer = await run(prompt);
  if (answer.code !== 0)
    throw new UsageError(
      `Claude Code could not capture the alphaXiv library (exit ${answer.code}): ${answer.stderr.slice(-200)}`,
    );
  const results = toolResults(answer.stdout);
  const listed = results.find(({ name }) => name === tools.library);
  if (!listed)
    throw new UsageError(
      "The capture agent did not list the library; nothing was imported.",
    );
  const library = libraryResult.parse(
    JSON.parse(await resultText(listed.text, home)),
  );
  const pages = await Promise.all(
    results
      .filter(({ name }) => name === tools.annotated)
      .map(({ text }) => resultText(text, home)),
  );
  await mkdir(options.dir, { recursive: true, mode: 0o700 });
  const pending = path.join(options.dir, "alphaxiv-pending.json"),
    last = path.join(options.dir, "alphaxiv-last.json");
  const read = annotations(pages);
  // A page this version cannot read keeps the last snapshot's annotations
  // rather than removing them from the mirror.
  const annotated: Annotation[] =
    read ??
    (await readFile(last, "utf8")
      .then(
        (text) => alphaXivSnapshot.parse(JSON.parse(text)).annotations ?? [],
      )
      .catch(() => []));
  const warnings = read
    ? []
    : [
        "Could not read the annotated papers; kept the last snapshot's annotations.",
      ];
  const snapshot = alphaXivSnapshot.parse(
    snapshotFrom(library, takenAt, annotated),
  );
  await privateJson(pending, snapshotFrom(library, takenAt, annotated));
  const counts = {
    folders: snapshot.folders.length,
    memberships: snapshot.memberships.length,
    annotations: annotated.length,
  };
  if (!options.import)
    return { data: { status: "captured", file: pending, ...counts, warnings } };
  const imported = await (importSnapshot ?? missingImport)(pending);
  const status = (imported.data as { status?: string }).status;
  if (status === "synced" || status === "already-synced")
    await rename(pending, last);
  return {
    data: {
      ...(imported.data as object),
      status,
      ...counts,
      warnings,
    },
  };
}
const missingImport: ImportSnapshot = async () => {
  throw new Error("No alphaXiv import was given");
};
