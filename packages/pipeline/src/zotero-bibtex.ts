type Entry = { line: number; fields: Map<string, string> };
export type BibTeXIssue = { line: number; message: string };

const header =
  /%[^\r\n]*|@([a-z][a-z0-9_-]*)\s*([({])|^[^\S\r\n]*@([a-z][a-z0-9_-]*)/gim;
const recovery = /^[^\S\r\n]*@[a-z][a-z0-9_-]*/gim;
const accentMarks: Record<string, string> = {
  "'": "\u0301",
  "\x60": "\u0300",
  "^": "\u0302",
  "~": "\u0303",
  "=": "\u0304",
  ".": "\u0307",
  c: "\u0327",
  v: "\u030c",
  u: "\u0306",
  H: "\u030b",
  r: "\u030a",
  k: "\u0328",
};

export function bibText(value: string) {
  return value
    .replace(
      /\{\\\"([a-zA-Z])\}|\\\"\{([a-zA-Z])\}/g,
      (_, grouped: string | undefined, braced: string | undefined) =>
        (grouped ?? braced ?? "") + "\u0308",
    )
    .replace(
      /\\(['\x60^~=.]|[cvuHrk]\s+)\s*\{?([a-zA-Z])\}?/g,
      (_, mark: string, letter: string) => letter + accentMarks[mark.trim()],
    )
    .replace(
      /\\([{}%&#_$"\\])|[{}~]/g,
      (whole, escaped: string | undefined) =>
        escaped ?? (whole === "~" ? " " : ""),
    )
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

/** Split BibTeX lists without splitting protected names or comma-bearing tags. */
export function bibList(value: string, delimiter: RegExp) {
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === "{") depth++;
    else if (value[i] === "}") depth--;
    else if (!depth) {
      delimiter.lastIndex = i;
      const match = delimiter.exec(value);
      if (!match) continue;
      result.push(bibText(value.slice(start, i)));
      start = delimiter.lastIndex;
      i = start - 1;
    }
  }
  result.push(bibText(value.slice(start)));
  return result.filter(Boolean);
}

class BibTeXReader {
  private readonly macros = new Map(
    "January February March April May June July August September October November December"
      .split(" ")
      .map((month) => [month.slice(0, 3).toLowerCase(), month]),
  );
  private offset = 0;
  private end: number;
  private readonly lineStarts = [0];

  constructor(private readonly text: string) {
    this.end = text.length;
    for (const line of text.matchAll(/\r\n|\r|\n/g))
      this.lineStarts.push(line.index + line[0].length);
  }

  private line(at: number) {
    let low = 0,
      high = this.lineStarts.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (this.lineStarts[mid]! <= at) low = mid;
      else high = mid;
    }
    return low + 1;
  }

  private take(pattern: RegExp) {
    pattern.lastIndex = this.offset;
    const match = pattern.exec(this.text);
    if (!match || pattern.lastIndex > this.end) return undefined;
    this.offset = pattern.lastIndex;
    return match[0];
  }

  private trivia() {
    this.take(/(?:\s+|%[^\r\n]*)*/y);
  }

  private char() {
    return this.offset < this.end ? this.text[this.offset] : undefined;
  }

  private accept(char: string) {
    this.trivia();
    if (this.char() !== char) return false;
    this.offset++;
    return true;
  }

  private expect(char: string) {
    if (!this.accept(char)) throw new Error("Expected " + char);
  }

  private literal(open: string, close: string) {
    const start = ++this.offset;
    let depth = 0;
    for (; this.offset < this.end; this.offset++) {
      const char = this.char();
      if (char === "\\") this.offset++;
      else if (char === close && depth === 0)
        return this.text.slice(start, this.offset++);
      else if (char === (open === '"' ? "{" : open)) depth++;
      else if (char === (open === '"' ? "}" : close)) {
        if (!depth) throw new Error("Unbalanced braces in quoted value");
        depth--;
      }
    }
    throw new Error("Unterminated value or comment");
  }

  private value(needed = true) {
    const parts: string[] = [];
    do {
      this.trivia();
      const char = this.char();
      if (char === "{" || char === '"') {
        parts.push(this.literal(char, char === "{" ? "}" : '"'));
      } else {
        const word = this.take(/[^\s{}()"#=,%]+/y);
        if (!word) throw new Error("Expected a field value");
        if (/^\d+$/.test(word)) parts.push(word);
        else if (needed) {
          const macro = this.macros.get(word.toLowerCase());
          if (macro === undefined) throw new Error("Undefined string macro");
          parts.push(macro);
        }
      }
    } while (this.accept("#"));
    const length = parts.reduce((size, part) => size + part.length, 0);
    // Macro references can expand far beyond the original file.
    if (length > 256 * 1024) throw new Error("Expanded field is too large");
    return parts.join("");
  }

  private fieldName() {
    this.trivia();
    const name = this.take(/[a-z][a-z0-9_-]*/iy);
    if (!name) throw new Error("Expected a field name");
    this.expect("=");
    return name.toLowerCase();
  }

  private body(type: string, open: string, close: string) {
    if (type === "comment") {
      this.offset--;
      this.literal(open, close);
      return;
    }
    if (type === "string" || type === "preamble") {
      const name = type === "string" ? this.fieldName() : undefined;
      const value = this.value(type === "string");
      this.accept(",");
      this.expect(close);
      if (name) this.macros.set(name, value);
      return;
    }
    this.trivia();
    if (!this.take(/[^\s{},()="]+/y)) throw new Error("Expected an entry key");
    const fields = new Map<string, string>();
    if (this.accept(close)) return fields;
    this.expect(",");
    while (!this.accept(close)) {
      const name = this.fieldName();
      const needed = wanted.has(name);
      const value = this.value(needed);
      if (needed) {
        if (fields.has(name)) throw new Error("Repeated field");
        fields.set(name, value);
      }
      if (!this.accept(",")) {
        this.expect(close);
        break;
      }
    }
    return fields;
  }

  *read(): Generator<Entry | BibTeXIssue> {
    // Use local scanner state because parsing may be re-entered by another caller.
    const scan = new RegExp(header.source, header.flags);
    const sync = new RegExp(recovery.source, recovery.flags);
    let recovering = false;
    for (;;) {
      scan.lastIndex = this.offset;
      const match = scan.exec(this.text);
      if (!match) return;
      this.offset = scan.lastIndex;
      const line = this.line(match.index);
      if (!match[1]) {
        if (match[3]) yield { line, message: "Expected an entry opener" };
        continue;
      }
      const type = match[1].toLowerCase();
      const open = match[2]!;
      const start = this.offset;
      sync.lastIndex = this.lineStarts[line] ?? this.text.length;
      const next = sync.exec(this.text)?.index ?? this.text.length;
      this.end = recovering ? next : this.text.length;
      try {
        const fields = this.body(type, open, open === "{" ? "}" : ")");
        recovering = false;
        if (fields) yield { line, fields };
      } catch (error) {
        this.offset = Math.max(start, next);
        recovering = true;
        yield { line, message: (error as Error).message };
      }
    }
  }
}

const wanted = new Set([
  "title",
  "author",
  "year",
  "doi",
  "url",
  "eprint",
  "archiveprefix",
  "keywords",
  "groups",
  "collections",
  "journal",
  "booktitle",
  "abstract",
]);
export const readBibTeX = (text: string) => new BibTeXReader(text).read();
