/** Only public HTTP(S) hostnames. Workers also require global_fetch_strictly_public. */
export function publicHttpUrl(value: string, base?: URL): URL | undefined {
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.port &&
      !url.username &&
      !url.password &&
      host.includes(".") &&
      !/^[\d.]+$/.test(host) &&
      !host.includes(":") &&
      !/\.(?:local|localhost|internal|lan|home\.arpa|onion)$/.test(host)
    ) {
      url.hash = "";
      return url;
    }
  } catch {
    // Invalid URL.
  }
  return undefined;
}
