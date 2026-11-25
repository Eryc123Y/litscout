import { parsePaperId, type ParsedPaperId } from "@litscout/core/ids";
import { publicHttpUrl } from "@litscout/core/public-url";
import { doiPath } from "@litscout/core/normalize";
import type { Paper } from "@litscout/core/types";

export type Identity = {
  scheme:
    | "doi"
    | "arxiv"
    | "openalex"
    | "s2"
    | "openreview"
    | "acl"
    | "pmlr"
    | "jmlr"
    | "pmid"
    | "dblp"
    | "url";
  value: string;
};
export function parsedId(value: string): ParsedPaperId | undefined {
  try {
    return parsePaperId(value);
  } catch {
    return undefined;
  }
}
export function identityFor(id: ParsedPaperId): Identity | undefined {
  if (id.kind === "corpus" || id.kind === "pmcid") return undefined;
  return { scheme: id.kind, value: id.value };
}

export function isPrivateAlphaXiv(url: URL | undefined) {
  return (
    !!url &&
    /(^|\.)alphaxiv\.org$/.test(url.hostname) &&
    /^\/private(?:\/|$)/i.test(decodePath(url.pathname))
  );
}

export function lookupInput(query: string) {
  const prefixed = /^(openreview|acl|pmlr|jmlr|dblp|url):(.+)$/.exec(query);
  const platformId = prefixed?.[2];
  const platformPage =
    typeof platformId === "string" && prefixed?.[1] === "openreview"
      ? "https://openreview.net/forum?" +
        new URLSearchParams({ id: platformId })
      : undefined;
  const url = publicHttpUrl(
    platformPage ?? (prefixed?.[1] === "url" ? platformId! : query),
  );
  let parsed = parsedId(query);
  let platform: Identity | undefined = prefixed
    ? { scheme: prefixed[1] as Identity["scheme"], value: platformId! }
    : undefined;
  if (url) {
    const host = url.hostname.replace(/^www\./, "");
    const path = decodePath(url.pathname);
    if (/(^|\.)alphaxiv\.org$/.test(host))
      parsed ??= parsedId(path.replace(/^\/(?:abs|pdf)\//, ""));
    const doi =
      url.searchParams.get("doi") ??
      [...url.searchParams.values()].find((value) =>
        /^10\.\d{4,9}\/\S+$/i.test(value),
      ) ??
      path.match(/10\.\d{4,9}\/[\w.()/:;+-]+/i)?.[0];
    if (doi) parsed ??= parsedId(doi);
    if (host === "openreview.net" && url.searchParams.get("id"))
      platform = { scheme: "openreview", value: url.searchParams.get("id")! };
    if (host === "aclanthology.org" && /^\/[a-z\d.-]+\/?$/i.test(path))
      platform = { scheme: "acl", value: path.replace(/^\/|\/$/g, "") };
    if (
      host === "proceedings.mlr.press" &&
      /^\/v\d+\/[a-z\d-]+\.html$/i.test(path)
    )
      platform = { scheme: "pmlr", value: path.replace(/^\/|\.html$/g, "") };
    if (host === "jmlr.org" && /^\/papers\/v\d+\/[a-z\d-]+\.html$/i.test(path))
      platform = {
        scheme: "jmlr",
        value: path.replace(/^\/papers\/|\.html$/g, ""),
      };
    if (host === "pubmed.ncbi.nlm.nih.gov" && /^\/\d+\/?$/.test(path))
      parsed ??= parsedId("PMID:" + path.replaceAll("/", ""));
    if (host === "dblp.org" && path.startsWith("/rec/"))
      platform = {
        scheme: "dblp",
        value: path.slice(5).replace(/\.html$/, ""),
      };
  }
  const isUrl =
    Boolean(prefixed) || /^(?:[a-z][a-z\d+.-]*:\/\/|https?:)/i.test(query);
  return { parsed, platform, url, isUrl };
}

function decodePath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
export const doiUrl = (doi: string) => "https://doi.org/" + doiPath(doi);

export function paperIdentities(paper: Paper): Identity[] {
  return [
    ...(paper.doi ? [parsedId(paper.doi)] : []),
    ...(paper.arxiv ? [parsedId("arxiv:" + paper.arxiv)] : []),
    ...(paper.openalexId ? [parsedId(paper.openalexId)] : []),
    ...(paper.s2Id ? [parsedId("s2:" + paper.s2Id)] : []),
  ].flatMap((id) => {
    const identity = id && identityFor(id);
    return identity ? [identity] : [];
  });
}
