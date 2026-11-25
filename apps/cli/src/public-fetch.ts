import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { request } from "node:https";
import { Readable } from "node:stream";
function publicV4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a! >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return publicV4(address);
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::"),
    head = left!.split(":").filter(Boolean),
    tail = right?.split(":").filter(Boolean) ?? [];
  const words = [
    ...head,
    ...Array(8 - head.length - tail.length).fill("0"),
    ...tail,
  ].map((s) => parseInt(s, 16));
  if (words.slice(0, 5).every((n) => n === 0) && words[5] === 65535)
    return publicV4(
      [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join(
        ".",
      ),
    );
  return (
    (words[0]! & 0xe000) === 0x2000 &&
    !(words[0] === 0x2001 && words[1] === 0xdb8)
  );
}
export class NonPublicAddressError extends Error {}

async function resolvePublic(value: string) {
  const url = new URL(value),
    host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    host === "localhost" ||
    /\.(?:localhost|local|internal)$/.test(host)
  )
    throw new Error("Full text must use a public HTTPS link");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new NonPublicAddressError(
      "Host must resolve only to public HTTPS addresses",
    );
  return { url, addresses };
}
function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return (_host, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}
/** Pin the checked DNS answer to the TLS connection; do not perform a second lookup. */
function pinnedRequest(
  url: URL,
  addresses: LookupAddress[],
  init: {
    method?: string;
    headers?: HeadersInit;
    body?: string;
    signal: AbortSignal;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        lookup: pinnedLookup(addresses),
        agent: false,
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal,
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const status = response.statusCode!;
        const empty = [204, 205, 304].includes(status);
        if (empty) response.resume();
        resolve(
          new Response(
            empty
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers },
          ),
        );
      },
    );
    req.once("error", reject);
    req.end(init.body);
  });
}
export async function fetchPublicPdf(value: string, impl: typeof fetch) {
  const { url, addresses } = await resolvePublic(value);
  return impl === globalThis.fetch
    ? pinnedRequest(url, addresses, { signal: AbortSignal.timeout(60000) })
    : impl(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
}
export async function preparePublicJsonPost(value: string) {
  const { url, addresses } = await resolvePublic(value);
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const response = await pinnedRequest(url, addresses, {
      method: "POST",
      headers: init?.headers,
      body: String(init?.body),
      signal: init?.signal ?? AbortSignal.timeout(60000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new Error("API redirect refused");
    }
    return response;
  };
}
export async function limitedPdf(response: Response, maximum = 30000000) {
  const fail = async () => {
    await response.body?.cancel();
    throw new Error("Full text PDF exceeds 30 MB");
  };
  if (Number(response.headers.get("content-length")) > maximum) return fail();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error("Full text PDF exceeds 30 MB");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    output.set(chunk, at);
    at += chunk.byteLength;
  }
  return output;
}
