import { z } from "zod";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  localVaultSource,
  openVault,
  type VaultConfig,
} from "@litscout/sync/vault-source";
import { hash, parseNote } from "@litscout/sync/vault-note";

export function readDigestBriefs(files: string[], base: string) {
  return Promise.all(
    files.map(async (file) => ({
      path: file,
      body: await readFile(path.resolve(base, file), "utf8"),
    })),
  );
}

export async function localDigestResearch(
  config: VaultConfig,
  base = process.cwd(),
  contextBodies: boolean,
) {
  if (
    !(await lstat(path.resolve(base, config.root)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    ))
  )
    return undefined;
  const vault = await openVault(config, base);
  const { notes } = await localVaultSource(vault, {
    ...config,
    uploadDescriptions: true,
  }).index();
  const openIdeas = [];
  const vaultProjects = [];
  const bodies: string[] = [];
  let remaining = 120_000;
  for (const note of notes) {
    const status =
      "status" in note.frontmatter
        ? note.frontmatter.status?.trim().toLowerCase()
        : undefined;
    const isIdea =
      note.kind === "idea" && (status === "seed" || status === "exploring");
    const isProject = note.kind === "project";
    if (
      (!isIdea || openIdeas.length >= 100) &&
      (!isProject || vaultProjects.length >= 50)
    )
      continue;
    const text = await vault.read(note.path);
    // A file may have become private since the index pass.
    if (text === null || hash(text) !== note.hash) continue;
    const body = parseNote(text).body.trim();
    bodies.push(body);
    const includeBody = contextBodies && body.length <= remaining;
    const fields = {
      id: note.id,
      title: note.title,
      path: note.path,
      ...(includeBody ? { body } : {}),
    };
    if (includeBody) remaining -= body.length;
    if (isIdea && note.kind === "idea")
      openIdeas.push({
        ...fields,
        status,
        description: note.frontmatter.description ?? null,
        project: note.frontmatter.project ?? null,
      });
    else if (note.kind === "project")
      vaultProjects.push({
        ...fields,
        status: status || null,
        description: note.frontmatter.description ?? null,
      });
  }
  return { fields: { openIdeas, vaultProjects }, bodies };
}

export type DigestResearch = Awaited<ReturnType<typeof localDigestResearch>>;

const words = new Intl.Segmenter(undefined, { granularity: "word" });

export function privateDigestText(
  briefs: { body: string }[],
  research: DigestResearch,
) {
  const text = briefs.map(({ body }) => body);
  if (research) {
    text.push(...research.bodies);
    for (const { title, description } of [
      ...research.fields.openIdeas,
      ...research.fields.vaultProjects,
    ]) {
      if (description) text.push(description);
      if (
        [...words.segment(title)].filter(({ isWordLike }) => isWordLike)
          .length > 3
      )
        text.push(title);
    }
  }
  return text;
}

const remoteNote = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  status: z.string().nullable().optional(),
});
const remoteProject = remoteNote.extend({
  summary: z.string().nullable().optional(),
});
const remoteIdea = remoteNote.extend({
  description: z.string().nullable().optional(),
  project: z.string().nullable().optional(),
});
async function allPages<T>(
  get: (path: string) => Promise<unknown>,
  route: string,
  item: z.ZodType<T>,
  limit: number,
): Promise<T[]> {
  const page = z.object({ items: z.array(item), next: z.string().nullable() });
  const items: T[] = [];
  let after = "";
  do {
    const parsed = page.parse(
      await get(after ? `${route}?after=${encodeURIComponent(after)}` : route),
    );
    items.push(...parsed.items);
    after = parsed.next ?? "";
  } while (after && items.length < limit);
  return items.slice(0, limit);
}
const normalStatus = (status?: string | null) =>
  status?.trim().toLowerCase() || null;

/**
 * The same research context from the instance's vault index, for a machine
 * that has no vault (an own server). Descriptions are present only when the
 * vault sync uploads them, and note bodies are never sent.
 */
export async function remoteDigestResearch(
  get: (path: string) => Promise<unknown>,
) {
  const [projects, ideas] = await Promise.all([
    allPages(get, "/projects", remoteProject, 50),
    allPages(get, "/ideas", remoteIdea, 500),
  ]);
  const openIdeas = ideas
    .map((idea) => ({ idea, status: normalStatus(idea.status) ?? "" }))
    .filter(({ status }) => status === "seed" || status === "exploring")
    .slice(0, 100)
    .map(({ idea, status }) => ({
      id: idea.id,
      title: idea.title,
      path: idea.path,
      status,
      description: idea.description ?? null,
      project: idea.project ?? null,
    }));
  const vaultProjects = projects.map((project) => ({
    id: project.id,
    title: project.title,
    path: project.path,
    status: normalStatus(project.status),
    description: project.summary ?? null,
  }));
  return { fields: { openIdeas, vaultProjects }, bodies: [] as string[] };
}
