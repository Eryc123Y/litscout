import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isSeq } from "yaml";
import { vaultTitleKey } from "@litscout/core/normalize";
import type {
  QueuedVaultRequest,
  VaultNote,
  VaultPaper,
} from "@litscout/pipeline/vault-contracts";
import { vaultPath } from "@litscout/pipeline/vault-contracts";
import {
  localVaultSource,
  type VaultConfig,
  type VaultFiles,
} from "./vault-source";
import {
  editFrontmatter,
  editStatus,
  identifier,
  hash,
  managedBlock,
  parseNote,
  putBlock,
  VaultError,
} from "./vault-note";

import {
  httpsTarget,
  inlineText,
  quotedText,
  safeDigestMarkdown,
  textLink,
  yamlText,
} from "./vault-markdown";

export type VaultWrite = { path: string; changed: boolean };
export interface VaultSink {
  request(request: QueuedVaultRequest): Promise<VaultWrite>;
  block(file: string, paper: VaultPaper): Promise<VaultWrite>;
  digest(day: string, markdown: string, adopt?: boolean): Promise<VaultWrite>;
}

const digestStamp = "<!-- litscout:digest -->";
export async function checkDigestDirectory(
  vault: VaultFiles,
  dir: string,
  adopt: boolean,
) {
  for await (const candidate of vault.files(dir)) {
    if (adopt) return;
    const body = await vault.read(candidate);
    if (!body?.split(/\r?\n/).includes(digestStamp))
      throw new VaultError(
        "The digest folder contains files not written by LitScout. Choose a separate folder or use --adopt.",
      );
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const pathIdentifier = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");
function paperUrls(paper: VaultPaper) {
  const arxiv = paper.arxiv ? identifier(paper.arxiv) : undefined;
  const doi = paper.doi ? identifier(paper.doi) : undefined;
  const arxivPath =
    arxiv?.kind === "arxiv" ? pathIdentifier(arxiv.value) : undefined;
  return {
    doi:
      doi?.kind === "doi"
        ? httpsTarget("https://doi.org/" + pathIdentifier(doi.value))
        : undefined,
    abstract: arxivPath
      ? httpsTarget("https://arxiv.org/abs/" + arxivPath)
      : undefined,
    pdf:
      paper.links
        .filter(({ kind }) => kind === "pdf_oa")
        .map(({ url }) => httpsTarget(url))
        .find(Boolean) ??
      (arxivPath
        ? httpsTarget("https://arxiv.org/pdf/" + arxivPath)
        : undefined),
    alphaXiv: arxivPath
      ? httpsTarget("https://www.alphaxiv.org/abs/" + arxivPath)
      : undefined,
  };
}

function renderPaper(paper: VaultPaper) {
  const summary = paper.summary;
  const { doi, pdf, alphaXiv } = paperUrls(paper);
  return [
    "## From LitScout",
    summary &&
      [
        ["TL;DR", summary.tldr],
        ["Motivation", summary.motivation],
        ["Method", summary.method],
        ["Result", summary.result],
        ["Conclusion", summary.conclusion],
      ]
        .map(([title, text]) => "### " + title + "\n\n" + quotedText(text!))
        .join("\n\n"),
    [
      doi && textLink("DOI", doi),
      pdf && textLink("PDF", pdf),
      alphaXiv && textLink("alphaXiv", alphaXiv),
    ]
      .filter(Boolean)
      .join(" · "),
    paper.notes.length &&
      "### Quick notes\n\n" + paper.notes.map(quotedText).join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function capturePaper(paper: VaultPaper) {
  const urls = paperUrls(paper);
  const target =
    urls.doi ??
    urls.abstract ??
    httpsTarget(paper.url) ??
    paper.links.map(({ url }) => httpsTarget(url)).find(Boolean);
  return textLink(paper.title, target);
}

const paperTemplate = "---\n{{frontmatter}}\n---\n\n# {{heading}}\n";
const digestTemplate =
  "---\n{{frontmatter}}\n---\n\n# LitScout digest · {{date}}\n";
async function template(
  file: string | undefined,
  fallback: string,
  baseDir: string,
  values: Record<string, string>,
) {
  const source = file
    ? await readFile(path.resolve(baseDir, file), "utf8").catch(() => {
        throw new VaultError(
          "The configured vault template could not be read.",
        );
      })
    : fallback;
  const render = (frontmatter: string) =>
    source.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!Object.hasOwn(values, key))
        throw new VaultError("Unsupported vault template placeholder.");
      return key === "frontmatter" ? frontmatter : values[key]!;
    });
  const generated = values.frontmatter!;
  if (!file || !source.includes("{{frontmatter}}")) return render(generated);
  // Earlier starter templates already declare type and description.
  const { doc } = parseNote(render(""));
  return render(
    generated
      .split("\n")
      .filter(
        (line) =>
          !/^(type|description):/.test(line) || !doc.has(line.split(":")[0]!),
      )
      .join("\n"),
  );
}
function child(dir: string, name: string) {
  return vaultPath.parse(dir.replace(/\/+$/, "")) + "/" + name;
}

export function localVaultSink(
  vault: VaultFiles,
  config: VaultConfig,
  {
    dryRun = false,
    configDir = process.cwd(),
    indexedNotes,
  }: {
    dryRun?: boolean;
    configDir?: string;
    indexedNotes?: readonly VaultNote[];
  } = {},
): VaultSink {
  const pending = new Map<string, string>();
  const createdByTitle = new Map<string, string>();
  const read = (file: string) =>
    pending.has(file) ? Promise.resolve(pending.get(file)!) : vault.read(file);
  async function save(
    file: string,
    old: string | null,
    next: string,
  ): Promise<VaultWrite> {
    if (old === next) return { path: file, changed: false };
    if (config.write && !dryRun) await vault.write(file, old, next);
    else pending.set(file, next);
    return { path: file, changed: true };
  }
  async function existing(file: string) {
    const old = await read(file);
    if (old === null) throw new VaultError("The target note no longer exists.");
    return old;
  }

  async function capture(
    request: Extract<QueuedVaultRequest, { kind: "capture" }>,
  ) {
    const file = config.inbox,
      old = await read(file);
    const text =
        old ??
        "---\ntype: inbox\ntags: [type/inbox]\ndescription: Incoming research captures\nai-first: false\n---\n",
      { eol, body } = parseNote(text);
    const marker = "<!-- litscout:capture=" + request.id + " -->";
    const block = managedBlock(body);
    if (block?.content.split(/\r?\n/).some((line) => line.endsWith(marker)))
      return { path: file, changed: false };
    const heading = /^## From LitScout[ \t]*(?:\r?\n|$)/m.exec(body);
    if (
      block &&
      (!heading ||
        block.start < heading.index ||
        /^#{1,2}\s/m.test(
          body.slice(heading.index + heading[0].length, block.start),
        ))
    )
      throw new VaultError(
        "The Inbox already has a LitScout block outside its capture section.",
      );
    const bullet =
      "- " +
      inlineText(request.title) +
      (request.body ? " — " + inlineText(request.body) : "") +
      (request.paper ? " · " + capturePaper(request.paper) : "") +
      (request.references ?? [])
        .map((ref) => {
          if (ref.kind === "paper")
            return " · " + textLink(ref.title, httpsTarget(ref.url));
          const relative = path.posix.relative(
            path.posix.dirname(file),
            ref.path,
          );
          const target = relative
            .split("/")
            .map((segment) =>
              encodeURIComponent(segment).replace(
                /[!'()*]/g,
                (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
              ),
            )
            .join("/");
          return " · " + textLink(ref.title, "<" + target + ">");
        })
        .join("") +
      " " +
      marker;
    const content = block ? block.content + eol + bullet : bullet;
    const withHeading = heading
      ? text
      : text +
        (text ? (text.endsWith("\n") ? eol : eol + eol) : "") +
        "## From LitScout" +
        eol;
    const insert = heading
      ? text.length - body.length + heading.index + heading[0].length
      : withHeading.length;
    // An existing final heading without a newline needs a separator before the block.
    return save(file, old, putBlock(withHeading, content, insert));
  }

  async function makePaper(
    request: Extract<QueuedVaultRequest, { kind: "make_paper_note" }>,
  ) {
    const { paper } = request;
    if (!paper) throw new VaultError("The paper is no longer available.");
    const key = vaultTitleKey(paper.title);
    const notes =
      indexedNotes ?? (await localVaultSource(vault, config).index()).notes;
    const paperNotes = notes.filter((note) => note.kind === "paper_note");
    const duplicate =
      createdByTitle.get(key) ??
      paperNotes.find((note) => key && vaultTitleKey(note.title) === key)?.path;
    const marker = "<!-- litscout:paper=" + request.id + " -->";
    if (duplicate) {
      const old = await read(duplicate);
      if (
        old !== null &&
        managedBlock(parseNote(old).body)
          ?.content.split(/\r?\n/)
          .includes(marker)
      )
        return { path: duplicate, changed: false };
      throw new VaultError(
        "A paper note with this title already exists at " + duplicate,
      );
    }
    const identified = paperNotes.find(
      ({ frontmatter }) =>
        (paper.arxiv && paper.arxiv === frontmatter.arxiv) ||
        (paper.doi && paper.doi === frontmatter.doi),
    );
    if (identified) return { path: identified.path, changed: false };
    if (!paper.arxiv && !paper.doi)
      throw new VaultError("The paper needs an arXiv identifier or DOI.");
    const dirs = config.paperNotes.dirs;
    const topic =
      request.topic ?? paper.topics.find((name) => Object.hasOwn(dirs, name));
    if (!topic || !Object.hasOwn(dirs, topic))
      throw new VaultError(
        "No vault folder is configured for this paper's topic.",
      );
    const dir = dirs[topic]!;
    const title = oneLine(paper.title)
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-")
      .replace(/^[.]+|[. ]+$/g, "");
    // Bound bytes for filesystems with byte-based name limits.
    const stem = Array.from(title).slice(0, 55).join("").trim() || "Paper";
    let available: string | undefined;
    for (let n = 1; n <= 100; n++) {
      const file = child(dir, stem + (n > 1 ? " (" + n + ")" : "") + ".md");
      const old = await read(file);
      if (old === null) {
        available ??= file;
        continue;
      }
      if (parseNote(old).doc.get("litscout_id") === paper.id)
        return { path: file, changed: false };
    }
    if (!available) throw new VaultError("No unused filename for this paper.");
    const frontmatter = [
      "type: paper",
      "tags: [type/paper]",
      "description: " + yamlText(paper.summary?.tldr || paper.title),
      "ai-first: true",
      "title: " + yamlText(paper.title),
      "litscout_id: " + yamlText(paper.id),
      paper.arxiv && "arxiv: " + yamlText(paper.arxiv),
      paper.doi && "doi: " + yamlText(paper.doi),
    ]
      .filter(Boolean)
      .join("\n");
    const content = await template(
      config.paperNotes.template,
      paperTemplate,
      configDir,
      {
        frontmatter,
        title: yamlText(paper.title),
        heading: inlineText(paper.title),
        litscout_id: yamlText(paper.id),
        arxiv: yamlText(paper.arxiv ?? ""),
        doi: yamlText(paper.doi ?? ""),
      },
    );
    const { doc } = parseNote(content);
    const tagNode = doc.get("tags", true);
    const tags = isSeq(tagNode)
      ? tagNode.toJSON().join(" ")
      : String(doc.get("tags") ?? "");
    if (
      doc.get("litscout_id") !== paper.id ||
      !tags
        .split(/[\s,]+/)
        .some((tag) => tag.replace(/^#/, "") === "type/paper") ||
      (paper.arxiv
        ? doc.get("arxiv") !== paper.arxiv
        : doc.get("doi") !== paper.doi)
    )
      throw new VaultError(
        "The paper template must include the paper tag, LitScout ID and paper identifier.",
      );
    const written = await save(
      available,
      null,
      putBlock(content, marker + "\n" + renderPaper(paper)),
    );
    if (key) createdByTitle.set(key, written.path);
    return written;
  }

  return {
    async request(request) {
      if (request.kind === "capture") return capture(request);
      if (request.kind === "make_paper_note") return makePaper(request);
      const file = request.target.path;
      if (hash(file) !== request.target.id)
        throw new VaultError("Invalid target path.");
      const old = await existing(file);
      if (request.kind === "set_status") {
        if (request.resultHash === hash(old))
          return { path: file, changed: false };
        if (hash(old) !== request.baseHash)
          throw new VaultError(
            "The note changed since the request was queued. The vault status was kept.",
          );
        return save(file, old, editStatus(old, request.status));
      }
      const id = request.paper?.arxiv ?? request.paper?.doi;
      if (!id)
        throw new VaultError("The paper needs an arXiv identifier or DOI.");
      const next = editFrontmatter(old, "papers", id);
      parseNote(next);
      return save(file, old, next);
    },
    async block(file, paper) {
      const old = await existing(file);
      const { body } = parseNote(old);
      const current = managedBlock(body);
      const marker =
        current?.content.match(/^<!-- litscout:paper=[\w-]+ -->\r?\n/)?.[0] ??
        "";
      const next = putBlock(body, marker + renderPaper(paper));
      return save(file, old, old.slice(0, old.length - body.length) + next);
    },
    async digest(day, markdown, adopt = false) {
      if (!z.iso.date().safeParse(day).success)
        throw new VaultError("Invalid digest date.");
      const dir = config.digestsDir.replace(/\/+$/, "");
      const file = child(dir, day + ".md"),
        old = await read(file);
      if (!adopt) await checkDigestDirectory(vault, dir, false);
      if (old !== null) {
        const block = managedBlock(parseNote(old).body);
        if (block?.content.split(/\r?\n/, 1)[0] !== digestStamp)
          throw new VaultError("The digest file was not written by LitScout.");
      }
      const base =
        old ??
        (await template(config.digestTemplate, digestTemplate, configDir, {
          frontmatter:
            "type: digest\ntags: [type/digest]\nai-first: true\ndescription: " +
            yamlText("LitScout research digest for " + day) +
            "\ndate: " +
            JSON.stringify(day),
          day: JSON.stringify(day),
          date: day,
        }));
      const { body, delimited } = parseNote(base);
      if (!delimited)
        throw new VaultError(
          "The digest template must include YAML frontmatter.",
        );
      const next = putBlock(
        body,
        digestStamp + "\n" + safeDigestMarkdown(markdown.trim()),
      );
      return save(file, old, base.slice(0, base.length - body.length) + next);
    },
  };
}
