import { fromMarkdown } from "mdast-util-from-markdown";
import {
  digestSchema,
  type DigestDraft,
  type FeedItem,
} from "@litscout/pipeline/contracts/index";

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  identifier?: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export function markdownFilter(papers: FeedItem[], browserUrl?: string) {
  const hosts = new Set(
    papers.flatMap(({ links }) =>
      links.map(({ url }) => new URL(url).hostname),
    ),
  );
  if (browserUrl) hosts.add(new URL(browserUrl).hostname);
  const allowed = (value?: string) => {
    const url = value ? URL.parse(value) : null;
    return (
      url &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      hosts.has(url.hostname)
    );
  };
  return (text: string) => {
    if (!/[!\[<]/.test(text)) return text;
    const root = fromMarkdown(text);
    const definitions = new Map<string, string>();
    function collect(node: MarkdownNode) {
      if (node.type === "definition" && !definitions.has(node.identifier!))
        definitions.set(node.identifier!, node.url!);
      node.children?.forEach(collect);
    }
    collect(root);
    // Edit original ranges to preserve formatting outside stripped nodes.
    function rewrite(nodes: MarkdownNode[], start: number, end: number) {
      let result = "";
      for (const node of nodes) {
        const from = node.position!.start.offset!;
        const to = node.position!.end.offset!;
        result += text.slice(start, from);
        const destination = node.url ?? definitions.get(node.identifier ?? "");
        const remove =
          ["image", "imageReference", "html"].includes(node.type) ||
          (node.type === "definition" && !allowed(destination));
        if (
          !remove &&
          (node.type === "link" || node.type === "linkReference") &&
          !allowed(destination)
        ) {
          const children = node.children ?? [];
          if (children.length && text[from] !== "<")
            result += rewrite(
              children,
              children[0]!.position!.start.offset!,
              children.at(-1)!.position!.end.offset!,
            );
        } else if (!remove) {
          result += node.children
            ? rewrite(node.children, from, to)
            : text.slice(from, to);
        }
        start = to;
      }
      return result + text.slice(start, end);
    }
    const stripped = rewrite(root.children, 0, text.length);
    return stripped === text ? text : stripped.trim();
  };
}

const overlapLength = 40;
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

function* windows(normalized: string) {
  // Use code points so a supplementary character counts as one character.
  const chars = Array.from(normalized);
  let start = 0,
    end = chars.slice(0, overlapLength).join("").length;
  for (let i = 0; i <= chars.length - overlapLength; i++) {
    yield {
      value: normalized.slice(start, end),
      start: i,
      end: i + overlapLength,
    };
    start += chars[i]!.length;
    end += chars[i + overlapLength]?.length ?? 0;
  }
}

function matchingWindows(fields: string[], candidates: Set<string>) {
  const matches = new Set<string>();
  if (!candidates.size) return matches;
  for (const field of fields)
    for (const { value } of windows(normalize(field))) {
      if (candidates.has(value)) matches.add(value);
      if (matches.size === candidates.size) return matches;
    }
  return matches;
}

type Span = { start: number; end: number };

function matchingSpans(
  text: string,
  matches: Set<string>,
  excluded: Span[] = [],
) {
  const spans: Span[] = [];
  if (!matches.size) return spans;
  let nextExcluded = 0;
  for (const { value, start, end } of windows(text)) {
    if (!matches.has(value)) continue;
    while (excluded[nextExcluded] && excluded[nextExcluded]!.end <= start)
      nextExcluded++;
    if (excluded[nextExcluded] && excluded[nextExcluded]!.start < end) continue;
    const last = spans.at(-1);
    if (last && start < last.end) last.end = end;
    else spans.push({ start, end });
  }
  return spans;
}

function redactSpans(text: string, spans: Span[]) {
  if (!spans.length) return text;
  const trimmed = text.trimStart();
  const leading = text.length - trimmed.length;
  // Each match corresponds to one code point in the normalized text.
  const original = [...trimmed.matchAll(/\s+|\S/gu)];
  let result = "";
  let cursor = 0;
  for (const { start, end } of spans) {
    const first = original[start]!;
    const last = original[end - 1]!;
    // Leave whitespace at the boundaries, including Markdown line breaks.
    const from =
      leading + first.index + (first[0].trim() ? 0 : first[0].length);
    const to = leading + last.index + (last[0].trim() ? last[0].length : 0);
    result += text.slice(cursor, from) + "[private context removed]";
    cursor = to;
  }
  return result + text.slice(cursor);
}

function mapDigestText(
  draft: DigestDraft,
  transform: (text: string) => string,
) {
  const picks = (rows: DigestDraft["other"]) =>
    rows.map((row) => ({ ...row, gist: transform(row.gist) }));
  return {
    ...draft,
    note: transform(draft.note),
    reportText: transform(draft.reportText),
    other: picks(draft.other),
    journal: picks(draft.journal),
    topics: Object.fromEntries(
      Object.entries(draft.topics).map(([name, rows]) => [name, picks(rows)]),
    ),
    radar: draft.radar.map((row) => ({
      ...row,
      ...(row.project !== undefined && {
        project: transform(row.project) || undefined,
      }),
      projectId:
        row.projectId === null ? null : transform(row.projectId) || null,
      reason: transform(row.reason),
      action: transform(row.action),
    })),
  };
}

export function filterDigestOutput(
  draft: DigestDraft,
  papers: FeedItem[],
  privateText: string[],
  topicNames: string[],
) {
  const strip = markdownFilter(papers);
  const proposed = draft.suggestions ?? [];
  const stripped = proposed.map((item) => ({
    ...item,
    title: strip(item.title),
    bodyMd: strip(item.bodyMd),
  }));
  const suggestionText = (item: (typeof proposed)[number]) => [
    item.title,
    item.bodyMd,
  ];
  const candidates = new Set<string>();
  const index = (text: string) => {
    if (privateText.length)
      for (const { value } of windows(normalize(text))) candidates.add(value);
  };
  const cleaned = mapDigestText(draft, (text) => {
    const safe = strip(text);
    index(safe);
    return safe;
  });
  [...proposed, ...stripped].flatMap(suggestionText).forEach(index);
  const privateMatches = matchingWindows(privateText, candidates);
  const publicMatches = privateMatches.size
    ? matchingWindows(
        [
          ...topicNames,
          ...papers.flatMap(({ title, abstract, topics }) => [
            title,
            abstract ?? "",
            ...topics,
          ]),
        ],
        candidates,
      )
    : new Set<string>();

  const privateSpans = (text: string) => {
    const normalized = normalize(text);
    // A copied span must contain 40 consecutive characters of private text,
    // even when the private source quotes public text next to it.
    return matchingSpans(
      normalized,
      privateMatches,
      matchingSpans(normalized, publicMatches),
    );
  };
  let redactions = 0;
  const redacted = mapDigestText(cleaned, (text) => {
    const spans = privateSpans(text);
    redactions += spans.length;
    return redactSpans(text, spans);
  });
  const suggestions = stripped.filter(
    (item, index) =>
      item.title &&
      item.bodyMd &&
      ![...suggestionText(proposed[index]!), ...suggestionText(item)].some(
        (text) => privateSpans(text).length,
      ),
  );
  return {
    draft: digestSchema.parse({ ...redacted, suggestions }),
    droppedSuggestions: proposed.length - suggestions.length,
    redactions,
  };
}
