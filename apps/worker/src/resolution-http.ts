import { publicHttpUrl } from "@litscout/core/public-url";

export const MAX_RESOLUTION_FETCHES = 10;
const JSON_BYTES = 192 * 1024;
const HEAD_BYTES = 48 * 1024;
const redirects = new Set([301, 302, 303, 307, 308]);

export async function boundedText(
  response: Response,
  limit: number,
  stopAtHead = false,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (bytes < limit) {
      const chunk = await reader.read();
      if (chunk.done) return parts.join("") + decoder.decode();
      const prefix = chunk.value.subarray(0, limit - bytes);
      bytes += prefix.length;
      const text = decoder.decode(prefix, { stream: true });
      parts.push(text);
      if (stopAtHead && /<\/(?:head)>|<body\b/i.test(text))
        return parts.join("");
    }
    return stopAtHead ? parts.join("") : "";
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function resolutionHttp(maxFetches = MAX_RESOLUTION_FETCHES) {
  let remaining = maxFetches;
  const deadline = Date.now() + 12_000;
  async function request(url: URL, headers?: HeadersInit) {
    const timeLeft = deadline - Date.now();
    if (remaining <= 0 || timeLeft <= 0) return undefined;
    remaining--;
    return fetch(url, {
      redirect: "manual",
      headers,
      signal: AbortSignal.timeout(Math.min(4500, timeLeft)),
    });
  }
  return {
    async json<T>(url: URL, headers?: HeadersInit): Promise<T | undefined> {
      try {
        const response = await request(url, headers);
        if (response?.ok)
          return JSON.parse(await boundedText(response, JSON_BYTES)) as T;
        void response?.body?.cancel().catch(() => {});
      } catch {
        // An unavailable or oversized source falls through to the next one.
      }
      return undefined;
    },
    async page(start: URL, maxRedirects = 3) {
      let url = start;
      try {
        for (let hop = 0; hop <= maxRedirects; hop++) {
          const response = await request(url, { accept: "text/html" });
          if (!response) break;
          if (
            response.ok &&
            /text\/html|application\/xhtml\+xml/i.test(
              response.headers.get("content-type") ?? "",
            )
          )
            return { url, html: await boundedText(response, HEAD_BYTES, true) };
          void response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          const target =
            location &&
            redirects.has(response.status) &&
            publicHttpUrl(location, url);
          if (!target) break;
          url = target;
        }
      } catch {
        // A publisher page is an optional metadata source.
      }
      return undefined;
    },
  };
}

function decodeAttribute(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return value
    .replace(
      /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt|nbsp);/gi,
      (whole, entity: string) => {
        if (!entity.startsWith("#"))
          return named[entity.toLowerCase()] ?? whole;
        const point =
          entity[1]?.toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      },
    )
    .trim();
}
export function citations(html: string) {
  const head = html.split(/<\/head\s*>|<body\b/i, 1)[0] ?? "";
  const metadata = new Map<string, string[]>();
  const tags = head.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    "",
  );
  for (const tag of tags.matchAll(/<meta\b[^<>]{0,2048}>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(
      /([^\s"'=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^"'=<>\s]+))/g,
    ))
      attrs.set(
        a[1]!.toLowerCase(),
        decodeAttribute(a[2] ?? a[3] ?? a[4] ?? ""),
      );
    const name = attrs.get("name")?.toLowerCase();
    const content = attrs.get("content");
    if (name?.startsWith("citation_") && content) {
      const values = metadata.get(name) ?? [];
      if (values.length < 100) metadata.set(name, [...values, content]);
    }
  }
  return metadata;
}
