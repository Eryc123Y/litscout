import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { parsePaperId } from "@litscout/core/ids";

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class VaultError extends Error {}
export class HandEdited extends VaultError {
  constructor() {
    super("The LitScout block was edited by hand.");
  }
}

export function splitNote(text: string) {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const open = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
  if (!open)
    return {
      bom,
      eol,
      start: bom.length,
      end: bom.length,
      yaml: "",
      body: text.slice(bom.length),
      delimited: false,
    };
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!close)
    throw new VaultError("Frontmatter is missing its closing delimiter.");
  const start = open[0].length,
    end = start + close.index;
  return {
    bom,
    eol,
    start,
    end,
    yaml: text.slice(start, end),
    body: rest.slice(close.index + close[0].length),
    delimited: true,
  };
}

export function parseNote(text: string) {
  const parts = splitNote(text);
  const doc = parseDocument(parts.yaml);
  if (doc.errors.length || (doc.contents && !isMap(doc.contents)))
    throw new VaultError("Frontmatter must be a valid YAML mapping.");
  return { ...parts, doc };
}

export function identifier(raw: string) {
  try {
    const { kind, value } = parsePaperId(raw);
    return kind === "arxiv" || kind === "doi" ? { kind, value } : undefined;
  } catch {
    return undefined;
  }
}
const keyFor = (raw: string) => identifier(raw)?.value ?? raw;

export function editFrontmatter(
  text: string,
  key: "status" | "papers",
  value: string,
) {
  const { doc, yaml, start, end, delimited, eol, bom } = parseNote(text);
  const found = isMap(doc.contents)
    ? doc.contents.items.find(
        ({ key: node }) => isScalar(node) && node.value === key,
      )
    : undefined;
  const node = found?.value;
  const splice = (from: number, to: number, put: string) =>
    text.slice(0, start + from) + put + text.slice(start + to);
  const entry =
    key === "status"
      ? JSON.stringify(value)
      : "[" + JSON.stringify(value) + "]";
  if (!found) {
    // A root flow mapping needs insertion inside its closing brace.
    if (isMap(doc.contents) && doc.contents.flow && doc.contents.range) {
      const [from, to] = doc.contents.range;
      const insert = from + yaml.slice(from, to - 1).trimEnd().length;
      const prefix =
        doc.contents.items.length && yaml[insert - 1] !== "," ? ", " : " ";
      return splice(insert, insert, prefix + key + ": " + entry);
    }
    if (delimited)
      return splice(end - start, end - start, key + ": " + entry + eol);
    return (
      bom +
      "---" +
      eol +
      key +
      ": " +
      entry +
      eol +
      "---" +
      eol +
      text.slice(bom.length)
    );
  }
  if (
    isScalar(node) &&
    node.value === null &&
    node.range?.[0] === node.range?.[1] &&
    node.range
  ) {
    const [at] = node.range;
    const trailing = yaml.slice(0, at).match(/[ \t]*$/)![0].length;
    return splice(at - trailing, at - trailing, " " + entry);
  }
  if (
    key === "status" &&
    isScalar(node) &&
    node.range &&
    (!node.tag || node.tag === "tag:yaml.org,2002:str") &&
    !["BLOCK_FOLDED", "BLOCK_LITERAL"].includes(node.type ?? "")
  ) {
    if (node.value === value) return text;
    const [from, to] = node.range;
    const replacement =
      node.type === "QUOTE_SINGLE"
        ? "'" + value + "'"
        : node.type === "QUOTE_DOUBLE"
          ? JSON.stringify(value)
          : value;
    return splice(from, to, replacement);
  }
  if (key === "papers" && isSeq(node) && node.range) {
    if (
      node.items.some(
        (item) =>
          isScalar(item) &&
          typeof item.value === "string" &&
          keyFor(item.value) === keyFor(value),
      )
    )
      return text;
    const [from, to] = node.range;
    if (node.flow && !/[\r\n#]/.test(yaml.slice(from, to))) {
      const insert = from + yaml.slice(from, to - 1).trimEnd().length;
      const comma =
        node.items.length && yaml[insert - 1] !== ","
          ? ", "
          : node.items.length
            ? " "
            : "";
      return splice(insert, insert, comma + JSON.stringify(value));
    }
    if (node.flow) {
      const last = node.items.at(-1);
      const close = to - 1;
      const lineStart = yaml.lastIndexOf("\n", close - 1) + 1;
      // Append after comments and delimit the previous value at its token end.
      if (
        isScalar(last) &&
        last.range &&
        /^\s*$/.test(yaml.slice(lineStart, close))
      ) {
        const lastEnd = last.range[1];
        const after = yaml.slice(lastEnd, lineStart);
        const comma = /^\s*,/.test(after) ? "" : ",";
        const indent = yaml.slice(lineStart, close);
        return (
          text.slice(0, start + lastEnd) +
          comma +
          after +
          indent +
          "  " +
          JSON.stringify(value) +
          eol +
          text.slice(start + lineStart)
        );
      }
    } else {
      const last = node.items.at(-1);
      if (isScalar(last) && last.range) {
        const lineEnd = yaml.indexOf("\n", last.range[1]);
        const indent = yaml.slice(yaml.lastIndexOf("\n", from - 1) + 1, from);
        if (lineEnd !== -1 && /^[ \t]*$/.test(indent))
          return splice(
            lineEnd + 1,
            lineEnd + 1,
            indent + "- " + JSON.stringify(value) + eol,
          );
      }
    }
  }
  throw new VaultError(
    "The frontmatter value cannot be edited without changing its formatting.",
  );
}

export function editStatus(text: string, value: string) {
  const edited = editFrontmatter(text, "status", value);
  const original = parseNote(text).doc.toJS({ mapAsMap: true }) ?? new Map();
  const updated = parseNote(edited).doc.toJS({ mapAsMap: true });
  if (updated.get("status") !== value)
    throw new VaultError(
      "The status edit did not produce the requested value.",
    );
  original.delete("status");
  updated.delete("status");
  if (!isDeepStrictEqual(original, updated))
    throw new VaultError(
      "The status edit would change other frontmatter values.",
    );
  return edited;
}

const begin = "<!-- litscout:begin -->";
const end = "<!-- litscout:end -->";
function markers(text: string, token: string) {
  return [...text.matchAll(new RegExp("^" + token + "(?=\\r?$)", "gm"))];
}

export function managedBlock(text: string) {
  const opens = markers(text, begin),
    closes = markers(text, end);
  if (!opens.length && !closes.length) return null;
  if (
    opens.length !== 1 ||
    closes.length !== 1 ||
    opens[0]!.index >= closes[0]!.index
  )
    throw new HandEdited();
  const start = opens[0]!.index + opens[0]![0].length;
  const stop = closes[0]!.index;
  const inner = text.slice(start, stop);
  const match =
    /^\r?\n<!-- litscout:sha256=([a-f0-9]{64}) -->\r?\n([^]*?)\r?\n$/.exec(
      inner,
    );
  if (!match || hash(match[2]!) !== match[1]) throw new HandEdited();
  return { start, stop, content: match[2]! };
}

export function putBlock(text: string, content: string, insert = text.length) {
  const current = managedBlock(text);
  const eol = splitNote(text).eol;
  const body = content.replace(/\r?\n/g, eol);
  if (current?.content === body) return text;
  const inner =
    eol + "<!-- litscout:sha256=" + hash(body) + " -->" + eol + body + eol;
  if (current)
    return text.slice(0, current.start) + inner + text.slice(current.stop);
  const prefix = text.slice(0, insert);
  const separator = !prefix ? "" : prefix.endsWith("\n") ? eol : eol + eol;
  return prefix + separator + begin + inner + end + eol + text.slice(insert);
}
