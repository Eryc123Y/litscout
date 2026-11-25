import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import {
  backupDataKeys,
  backupDataSections,
  backupManifestSchema,
  backupPageSchema,
  backupPaperBatchSize,
  backupPaperChildPageSize,
  backupPaperPageSchema,
  backupPaperReferences,
  backupSectionSchemas,
  backupSections,
  type BackupBundle,
  type BackupPaperCursor,
  type BackupSection,
} from "./backup-contracts";

type Data = BackupBundle["data"];
type Section = keyof Data;
type Row = Data[Section][number];
type Counts = BackupBundle["counts"];
type Manifest = z.output<typeof backupManifestSchema>;
type Read = <T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: BackupPaperCursor[],
) => Promise<T>;
export type BackupProgress = {
  records: number;
  completed: number;
  total: number;
};
type Options = {
  createdAt?: Date;
  signal?: AbortSignal;
  onProgress?: (value: BackupProgress) => void;
};
type Page = { section: Section; rows: Row[]; last: boolean };

export class BackupError extends Error {}

export function backupReader(
  request: (path: string, init: RequestInit) => Promise<Response>,
): Read {
  return async (path, schema, signal, body) => {
    const response = await request(`/api/v1${path}`, {
      signal,
      headers: {
        Accept: "application/json",
        ...(body && { "Content-Type": "application/json" }),
      },
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 429 || response.status === 500) {
        const failure = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const error = failure?.error;
        const seconds = response.headers.get("Retry-After");
        if (
          error?.code === "BACKUP_COOLDOWN" &&
          seconds &&
          /^\d{1,3}$/.test(seconds)
        )
          throw new BackupError(
            `An export recently started. Try again in ${seconds} seconds.`,
          );
        if (
          error?.code === "CORRUPT_BACKUP_ROW" &&
          typeof error.message === "string"
        )
          throw new BackupError(error.message);
      }
      throw new BackupError(`Export request failed (HTTP ${response.status}).`);
    }
    const payload = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    } | null;
    if (payload?.success !== true)
      throw new BackupError("The server did not return export data.");
    return schema.parse(payload.data);
  };
}

function* paperReferences(section: BackupSection, row: Row) {
  for (const { column, array, key } of backupPaperReferences[section] ?? []) {
    const field = (row as Record<string, unknown>)[column];
    const values = array ? (field as unknown[]) : [field];
    for (const value of values) {
      const id = key ? (value as Record<string, unknown> | null)?.[key] : value;
      if (typeof id === "string") yield id;
    }
  }
}

const utf8 = new TextEncoder();
function cursorAdvances(previous: string[], next: string[]) {
  const index = previous.findIndex((value, i) => value !== next[i]);
  if (index === -1) return false;
  // SQLite BINARY collation compares UTF-8 bytes. JS string order uses UTF-16.
  const before = utf8.encode(previous[index]!);
  const after = utf8.encode(next[index]!);
  for (let i = 0; i < Math.min(before.length, after.length); i++)
    if (before[i] !== after[i]) return before[i]! < after[i]!;
  return before.length < after.length;
}

function* childPages<T extends Row>(
  section: Section,
  rows: T[],
): Generator<Page> {
  for (let offset = 0; offset < rows.length; offset += backupPaperChildPageSize)
    yield {
      section,
      rows: rows.slice(offset, offset + backupPaperChildPageSize),
      last: false,
    };
  yield { section, rows: [], last: true };
}

async function* scanBackup(
  load: Read,
  manifest: Manifest,
  { onProgress }: Options,
): AsyncGenerator<Page> {
  const total = backupSections.length + 1;
  let records = manifest.configuredTopics.length;
  let completed = 0;
  const progress = () => onProgress?.({ records, completed, total });
  progress();

  const ids = new Set<string>();
  for (const section of backupSections) {
    const cursorSchema = z
      .array(z.string())
      .length(backupDataKeys[section].length);
    let cursor: string[] | undefined;
    let after: string | null = null;
    do {
      const query: string =
        after === null ? "" : `?${new URLSearchParams({ after })}`;
      const page = await load(
        `/backup/${section}${query}`,
        backupPageSchema(backupSectionSchemas[section]),
      );
      after = page.nextCursor;
      if (after !== null) {
        const next = cursorSchema.parse(JSON.parse(after));
        if (cursor && !cursorAdvances(cursor, next))
          throw new BackupError(`Export cursor in ${section} did not advance.`);
        cursor = next;
      }
      for (const row of page.items)
        for (const id of paperReferences(section, row)) if (id) ids.add(id);
      records += page.items.length;
      if (after === null) completed++;
      progress();
      yield { section, rows: page.items, last: after === null };
    } while (after !== null);
  }

  const paperIds = [...ids].sort();
  ids.clear();
  const identifiers: Data["paperIdentifiers"] = [];
  const links: Data["paperLinks"] = [];
  for (let index = 0; index < paperIds.length; index += backupPaperBatchSize) {
    let batch: BackupPaperCursor[] = paperIds
      .slice(index, index + backupPaperBatchSize)
      .map((id) => ({ id }));
    while (batch.length) {
      const pages = await load(
        "/backup/papers",
        backupPaperPageSchema,
        undefined,
        batch,
      );
      if (pages.length !== batch.length)
        throw new BackupError("Incomplete paper export page.");
      const papers: Data["papers"] = [];
      batch = pages.flatMap((page, i) => {
        const previous = batch[i]!;
        const { id, identifiersAfter, linksAfter } = page;
        if (
          page.id !== previous.id ||
          (previous.identifiersAfter === null &&
            page.identifiersAfter !== null) ||
          (previous.linksAfter === null && page.linksAfter !== null) ||
          (page.paper &&
            (page.paper.id !== page.id ||
              previous.identifiersAfter !== undefined ||
              previous.linksAfter !== undefined))
        )
          throw new BackupError("Invalid paper export cursor.");
        if (
          (previous.identifiersAfter &&
            identifiersAfter &&
            !cursorAdvances(previous.identifiersAfter, identifiersAfter)) ||
          (previous.linksAfter &&
            linksAfter &&
            !cursorAdvances(previous.linksAfter, linksAfter))
        )
          throw new BackupError(
            `Paper export cursor for ${id} did not advance.`,
          );
        if (page.paper) papers.push(page.paper);
        identifiers.push(...page.identifiers);
        links.push(...page.links);
        records +=
          Number(Boolean(page.paper)) +
          page.identifiers.length +
          page.links.length;
        if (identifiersAfter === null && linksAfter === null) return [];
        return [{ id, identifiersAfter, linksAfter }];
      });
      progress();
      yield { section: "papers", rows: papers, last: false };
    }
  }
  yield { section: "papers", rows: [], last: true };
  // The API pages the paper and its children together. JSON needs one
  // contiguous array per section, so only the child rows are buffered.
  yield* childPages("paperIdentifiers", identifiers);
  identifiers.length = 0;
  yield* childPages("paperLinks", links);
  completed++;
  progress();
}

function backupLoad(read: Read, signal?: AbortSignal): Read {
  return (path, schema, _signal, body) => {
    signal?.throwIfAborted();
    return read(path, schema, signal, body);
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const pairs = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${pairs.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function encodeData(configuredTopics: number) {
  const hash = sha256.create();
  const utf8 = new TextEncoder();
  const counts: Partial<Counts> = { configuredTopics };
  const update = (text: string) => {
    hash.update(utf8.encode(text));
    return text;
  };
  return {
    append({ section, rows, last }: Page) {
      const previous = counts[section];
      counts[section] = (previous ?? 0) + rows.length;
      const start =
        previous === undefined
          ? `${section === backupDataSections[0] ? "" : ","}${JSON.stringify(section)}:[`
          : previous > 0 && rows.length > 0
            ? ","
            : "";
      return update(
        start + rows.map(canonicalJson).join(",") + (last ? "]" : ""),
      );
    },
    start: () => update("{"),
    finish() {
      update("}");
      return { counts: counts as Counts, sha256: bytesToHex(hash.digest()) };
    },
  };
}

export async function collectBackup(
  read: Read,
  options: Options = {},
): Promise<BackupBundle> {
  const load = backupLoad(read, options.signal);
  const manifest = await load("/backup", backupManifestSchema);
  const { instanceName, configuredTopics, expectedCounts } = manifest;
  const data = Object.fromEntries(
    backupDataSections.map((section) => [section, [] as Row[]]),
  ) as Data;
  const encoder = encodeData(configuredTopics.length);
  encoder.start();
  for await (const page of scanBackup(load, manifest, options)) {
    (data[page.section] as Row[]).push(...page.rows);
    encoder.append(page);
  }
  options.signal?.throwIfAborted();
  return {
    schemaVersion: 1,
    instanceName,
    configuredTopics,
    expectedCounts,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    data,
    ...encoder.finish(),
  };
}

export async function* backupJson(read: Read, options: Options = {}) {
  const createdAt = (options.createdAt ?? new Date()).toISOString();
  const load = backupLoad(read, options.signal);
  const manifest = await load("/backup", backupManifestSchema);
  const { instanceName, configuredTopics, expectedCounts } = manifest;
  const encoder = encodeData(configuredTopics.length);
  const header = JSON.stringify({
    schemaVersion: 1,
    createdAt,
    instanceName,
    configuredTopics,
    expectedCounts,
  });
  yield header.slice(0, -1) + ',"data":' + encoder.start();
  for await (const page of scanBackup(load, manifest, options))
    yield encoder.append(page);
  options.signal?.throwIfAborted();
  yield "}," + JSON.stringify(encoder.finish()).slice(1);
}

export function verifyBackup(bundle: BackupBundle) {
  const { configuredTopics, data, counts, expectedCounts } = bundle;
  const encoder = encodeData(configuredTopics.length);
  encoder.start();
  for (const section of backupDataSections)
    for (const page of childPages(section, data[section] as Row[]))
      encoder.append(page);
  const actual = encoder.finish();
  const sections = [...backupDataSections, "configuredTopics"] as const;
  for (const section of sections)
    if (counts[section] !== actual.counts[section])
      throw new BackupError(
        `Export count mismatch in ${section}: expected ${counts[section]}, found ${actual.counts[section]}.`,
      );
  if (bundle.sha256 !== actual.sha256)
    throw new BackupError("Export SHA-256 does not match the data.");

  const keys = (section: Section, row: Row) =>
    backupDataKeys[section].map((key) => (row as Record<string, unknown>)[key]);
  for (const section of backupDataSections) {
    const seen = new Set<string>();
    for (const row of data[section]) {
      const key = JSON.stringify(keys(section, row));
      if (seen.has(key))
        throw new BackupError(`Duplicate key in ${section}: ${key}.`);
      seen.add(key);
    }
  }
  const papers = new Set(data.papers.map(({ id }) => id));
  function check(section: Section, key: unknown[], id: string) {
    if (!papers.has(id))
      throw new BackupError(
        `Missing paper reference in ${section}, key ${JSON.stringify(key)}: ${id}.`,
      );
  }
  const links = new Set<string>();
  for (const { paper_id, kind, url } of data.paperLinks) {
    const key = JSON.stringify([paper_id, kind, url]);
    if (links.has(key))
      throw new BackupError(`Duplicate link in paperLinks: ${key}.`);
    links.add(key);
  }
  for (const section of [
    "library",
    "paperState",
    "paperLinks",
    "paperIdentifiers",
  ] as const)
    for (const row of data[section])
      check(section, keys(section, row), row.paper_id);
  for (const section of ["digests", "weeklyDigests"] as const)
    for (const row of data[section])
      for (const id of paperReferences(section, row))
        check(section, keys(section, row), id);

  return sections.flatMap((section) =>
    expectedCounts[section] === actual.counts[section]
      ? []
      : [
          `${section} changed during export (expected ${expectedCounts[section]}, exported ${actual.counts[section]}).`,
        ],
  );
}

export const backupFilename = (at: string) =>
  `litscout-backup-${at.replaceAll(":", "-")}.json.gz`;
