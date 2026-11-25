// Character references preserve the displayed text without putting plugin
// delimiters or raw Markdown from external sources into the note.
const delimiters = /[&:`<>\[\]!$#%*_~|{}=\\]/g;
const escapeText = (text: string) =>
  text.replace(delimiters, (character) => "&#" + character.charCodeAt(0) + ";");

export function inlineText(text: string) {
  return escapeText(text.replace(/\s+/g, " ").trim());
}

export function quotedText(text: string) {
  return text
    .split(/\r\n?|\n/)
    .map((line) => "> " + escapeText(line))
    .join("\n");
}

export function yamlText(text: string) {
  // The YAML parser recovers the original value. Templater sees only escapes.
  return JSON.stringify(text).replace(
    /[&`<>\[\]!$#%]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

export function httpsTarget(input: string | undefined): string | undefined {
  if (!input || !URL.canParse(input)) return;
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) return;
  const rest = (url.pathname + url.search + url.hash).replace(
    /[<>\[\]`!]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return "<" + url.origin + rest + ">";
}

export function textLink(title: string, target: string | undefined) {
  const label = inlineText(title);
  return target ? "[" + label + "](" + target + ")" : label;
}

export function safeDigestMarkdown(markdown: string) {
  // The digest already contains headings and lists. Copy those harmless
  // markers and re-emit HTTPS links, escaping external text around them.
  const escapeDigestText = (text: string) =>
    escapeText(text).replaceAll("&#42;&#42;", "**");
  return markdown
    .split(/\r\n?|\n/)
    .map((line) => {
      const prefix = /^(?:#{1,6}|>) /.exec(line)?.[0] ?? "";
      const body = line.slice(prefix.length);
      const links = body.matchAll(
        /(?<!!)\[([^[\]\r\n]*)\]\((<[^<>\s]+>|[^()\s]+)\)/g,
      );
      let offset = 0,
        rendered = prefix;
      for (const link of links) {
        const at = link.index,
          href = link[2]!;
        const url = href.startsWith("<") ? href.slice(1, -1) : href;
        rendered +=
          escapeDigestText(body.slice(offset, at)) +
          textLink(link[1]!, httpsTarget(url));
        offset = at + link[0].length;
      }
      return rendered + escapeDigestText(body.slice(offset));
    })
    .join("\n");
}
