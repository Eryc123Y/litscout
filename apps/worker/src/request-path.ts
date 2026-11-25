/** Inspect the raw path before WHATWG URL parsing can remove dot segments. */
export function normaliseUrl(raw: string): string {
  const parts = /^(https?:\/\/[^/?#]+)([^?#]*)(.*)$/s.exec(raw);
  if (!parts) throw new Error("Invalid request URL");
  const path = (parts[2] || "/").replace(/\/{2,}/g, "/");
  const segments = path.split("/");
  // A paper identifier is opaque data inside one encoded segment. DOI and
  // historical arXiv identifiers can contain '/', which is not a route separator.
  const paperIdPath = /^\/api\/v1\/(?:public\/)?papers\/[^/]+$/.test(path);
  for (const [index, segment] of segments.entries()) {
    const decoded = decodeURIComponent(segment);
    const paperId = paperIdPath && index === segments.length - 1;
    if (
      decoded.split("/").includes("..") ||
      decoded.includes("\\") ||
      (!paperId && decoded.includes("/"))
    )
      throw new Error("Unsafe path");
  }
  return parts[1] + path + parts[3];
}
export function normaliseRequest(request: Request): Request {
  const url = normaliseUrl(request.url);
  return url === request.url ? request : new Request(url, request);
}
