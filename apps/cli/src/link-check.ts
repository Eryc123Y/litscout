import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { publicHttpUrl } from "@litscout/core/public-url";

type Probe = (
  url: URL,
  method: "HEAD" | "GET",
  signal: AbortSignal,
) => Promise<{ status: number; location?: string }>;
const privateNetworks = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  privateNetworks.addSubnet(network, prefix);
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  privateNetworks.addSubnet(network, prefix, "ipv6");

function isPublicAddress(address: string, family: number) {
  if (family === 4) return !privateNetworks.check(address, "ipv4");
  return (
    family === 6 &&
    globalIpv6.check(address, "ipv6") &&
    !privateNetworks.check(address, "ipv6")
  );
}

const probe: Probe = (url, method, signal) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method,
        signal,
        agent: false,
        headers: method === "GET" ? { Range: "bytes=0-0" } : undefined,
        // Validate the addresses returned to the socket so DNS cannot rebind after validation.
        lookup(host, options, callback) {
          lookup(
            host,
            { all: true, family: options.family },
            (error, found) => {
              if (error) return callback(error, "", 0);
              const permitted = found.filter(({ address, family }) =>
                isPublicAddress(address, family),
              );
              if (!permitted.length)
                return callback(new Error("No public address"), "", 0);
              if (options.all) return callback(null, permitted);
              const best = permitted[0]!;
              return callback(null, best.address, best.family);
            },
          );
        },
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location,
        });
        response.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });

const redirects = new Set([301, 302, 303, 307, 308]);
const useGet = new Set([400, 401, 403, 404, 405, 410, 501]);

async function follow(
  start: URL,
  method: "HEAD" | "GET",
  inspect: Probe,
  signal: AbortSignal,
) {
  let url = start;
  for (let hop = 0; hop <= 4; hop++) {
    const result = await inspect(url, method, signal);
    if (!redirects.has(result.status)) return { url, status: result.status };
    const next = result.location && publicHttpUrl(result.location, url);
    if (!next) break;
    url = next;
  }
  return undefined;
}

export async function checkLink(
  value: string,
  inspect = probe,
): Promise<number | null> {
  const url = publicHttpUrl(value);
  if (!url) return null;
  const signal = AbortSignal.timeout(8000);
  const head = await follow(url, "HEAD", inspect, signal).catch(
    () => undefined,
  );
  const get =
    !head || useGet.has(head.status)
      ? await follow(head?.url ?? url, "GET", inspect, signal).catch(
          () => undefined,
        )
      : undefined;
  return get?.status || head?.status || null;
}
