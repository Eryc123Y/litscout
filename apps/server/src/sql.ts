/**
 * Split SQL text into statements. A semicolon ends a statement unless it is
 * inside a quoted string or identifier, a comment, or the body of a
 * CREATE TRIGGER (which ends at `END;`). Comments before a statement stay
 * with it; text after the last semicolon is kept only if it is not just
 * whitespace and comments.
 */
export function splitSql(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  // Code outside quotes and comments since `start`, for keyword checks.
  let code = "";
  const flush = (end: number) => {
    const statement = text.slice(start, end).trim();
    if (statement) statements.push(statement);
    start = end;
    code = "";
  };
  while (i < text.length) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === "-" && next === "-") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline + 1;
      code += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      code += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === char) {
          if (text[j + 1] === char) j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
      code += " _ ";
      continue;
    }
    if (char === ";") {
      const trigger = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(
        code,
      );
      if (!trigger || /\bEND\s*$/i.test(code)) {
        flush(i + 1);
        i++;
        continue;
      }
    }
    code += char;
    i++;
  }
  // A trailing remainder without a semicolon: keep real SQL, drop comments.
  if (code.trim()) flush(text.length);
  return statements;
}
