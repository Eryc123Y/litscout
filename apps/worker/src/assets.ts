/** Vite names built files with an 8-character content hash that mixes
 * cases and digits: `index-CCE0mIhW.js`, `inter-latin-Dx4kXJAl.woff2`. */
const hashed = /^\/assets\/[^/]+-(?=[\w-]*[A-Z0-9])[\w-]{8}\.[a-z0-9]+$/;

/**
 * Assets binding responses have immutable headers; keep their bodies
 * streaming. A content-hashed file never changes under its name, so the
 * browser may keep it for a year without asking again; everything else
 * (the app shell, unhashed files, misses) keeps the binding's own headers.
 * An HTML answer on a hashed path is a fallback page, never the file.
 */
export async function assetResponse(
  request: Request,
  assets: Fetcher,
): Promise<Response> {
  const response = await assets.fetch(request);
  const copy = new Response(response.body, response);
  const type = response.headers.get("content-type") ?? "";
  const keep = response.headers.get("cache-control") ?? "";
  if (
    response.ok &&
    hashed.test(new URL(request.url).pathname) &&
    !type.includes("text/html") &&
    !keep.includes("no-store")
  )
    copy.headers.set("cache-control", "public, max-age=31536000, immutable");
  return copy;
}
