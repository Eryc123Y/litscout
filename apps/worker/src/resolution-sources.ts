import { doiPath } from "@litscout/core/normalize";
import { publicHttpUrl } from "@litscout/core/public-url";
import { mapWork } from "@litscout/sources/sources/openalex";
import {
  authorNames,
  itemDoi,
  plainText,
  publishedDay,
  type CrossrefItem,
} from "@litscout/sources/sources/crossref";
import { mapS2Paper, type RawPaper } from "@litscout/sources/sources/s2";
import type { Paper } from "@litscout/core/types";
import { doiUrl, lookupInput, parsedId } from "./paper-lookup";
import type { resolutionHttp } from "./resolution-http";
import type { AppEnv } from "./env";

type Parsed = NonNullable<ReturnType<typeof parsedId>>;
type Access = {
  url: string;
  licence?: string;
  oaStatus: string;
  source: string;
};
type Location = {
  landing_page_url?: string | null;
  pdf_url?: string | null;
  license?: string | null;
};
type OpenWork = Parameters<typeof mapWork>[0] & {
  primary_location?: Location;
  best_oa_location?: Location | null;
  locations?: Location[];
  type?: string;
  publication_date?: string;
  open_access?: { oa_status?: string };
};
type Resolved = Paper & {
  verified?: false;
  access?: Access;
  landing?: string;
  venueKind?: "journal" | "conference" | "workshop" | "preprint";
};
type Http = ReturnType<typeof resolutionHttp>;
const openFields =
  "id,doi,display_name,publication_year,primary_location,authorships,best_oa_location,open_access,locations,type,publication_date";
const s2Fields = "paperId,externalIds,title,year,venue,authors,abstract";
const url = (value?: string | null, base?: URL) =>
  value ? publicHttpUrl(value, base)?.href : undefined;

function safeAccess(
  location: Location | undefined | null,
  status: string | undefined,
  source: string,
): Access | undefined {
  const link = url(location?.pdf_url);
  return link
    ? {
        url: link,
        licence: location?.license || undefined,
        oaStatus: status ?? "unknown",
        source,
      }
    : undefined;
}
function openWork(raw: OpenWork): Resolved {
  const index = raw.abstract_inverted_index;
  // A bounded response can still contain a pathological sparse position.
  const work = mapWork(
    index
      ? {
          ...raw,
          abstract_inverted_index: Object.fromEntries(
            Object.entries(index).map(([word, positions]) => [
              word,
              Array.isArray(positions)
                ? positions.filter(
                    (pos) => Number.isInteger(pos) && pos >= 0 && pos < 4096,
                  )
                : [],
            ]),
          ),
        }
      : raw,
  );
  const locations = [raw.best_oa_location, ...(raw.locations ?? [])];
  const arxiv = [raw.primary_location, ...locations]
    .flatMap((l) =>
      [l?.landing_page_url, l?.pdf_url].map((v) => v && lookupInput(v).parsed),
    )
    .find((id) => id && id.kind === "arxiv");
  return {
    ...work,
    published: raw.publication_date,
    venueKind: raw.type === "preprint" || work.arxiv ? "preprint" : undefined,
    arxiv: work.arxiv ?? (arxiv ? arxiv.value : undefined),
    access: locations
      .map((l) => safeAccess(l, raw.open_access?.oa_status, "openalex"))
      .find(Boolean),
    landing: url(raw.primary_location?.landing_page_url),
  };
}

function crossrefWork(raw: CrossrefItem): Resolved {
  const doi = itemDoi(raw);
  const published = publishedDay(raw);
  return {
    id: doi ?? "",
    source: "crossref",
    doi,
    title: plainText(raw.title?.[0]) ?? "",
    published: published ?? undefined,
    venueKind:
      raw.type === "journal-article"
        ? "journal"
        : raw.type === "proceedings-article"
          ? "conference"
          : raw.type === "posted-content"
            ? "preprint"
            : undefined,
    authors: authorNames(raw).map((name) => ({ name })),
    year: published ? Number(published.slice(0, 4)) : undefined,
    venue: plainText(raw["container-title"]?.[0]) ?? undefined,
    landing: doi ? doiUrl(doi) : undefined,
  };
}

const valid = (p: Resolved) =>
  p.id && p.title.trim() && p.title !== "(untitled)";
export function resolutionSources(env: AppEnv, http: Http) {
  async function openalex(
    id?: Parsed,
    title?: string,
    details = false,
  ): Promise<Resolved[]> {
    const query = new URL("https://api.openalex.org/works");
    query.searchParams.set(
      "select",
      openFields + (details ? ",abstract_inverted_index" : ""),
    );
    if (env.OPENALEX_API_KEY)
      query.searchParams.set("api_key", env.OPENALEX_API_KEY);
    if (id?.openalexId) query.pathname += "/" + id.openalexId;
    else if (id?.openalexFilter?.attr === "doi")
      query.pathname += "/" + doiUrl(id.openalexFilter.value);
    else if (id?.openalexFilter)
      query.searchParams.set(
        "filter",
        `${id.openalexFilter.attr}:${id.openalexFilter.value}`,
      );
    else if (title) query.searchParams.set("search", title);
    else return [];
    query.searchParams.set("per_page", id ? "1" : "5");
    const response = await http.json<OpenWork & { results?: OpenWork[] }>(
      query,
    );
    return response
      ? (response.results ?? [response]).slice(0, 5).map(openWork).filter(valid)
      : [];
  }
  async function crossref(id?: Parsed, title?: string): Promise<Resolved[]> {
    const query = new URL("https://api.crossref.org/works");
    if (id?.openalexFilter?.attr === "doi")
      query.pathname += "/" + doiPath(id.openalexFilter.value);
    else if (title) {
      query.searchParams.set("query.title", title);
      query.searchParams.set("rows", "5");
      query.searchParams.set(
        "select",
        "DOI,title,author,published,type,container-title",
      );
    } else return [];
    const response = await http.json<{
      message?: CrossrefItem & { items?: CrossrefItem[] };
    }>(query);
    const message = response?.message;
    return message
      ? (message.items ?? [message]).slice(0, 5).map(crossrefWork).filter(valid)
      : [];
  }
  async function semantic(id?: Parsed, title?: string): Promise<Resolved[]> {
    const query = new URL("https://api.semanticscholar.org/graph/v1/paper");
    query.searchParams.set("fields", s2Fields);
    if (id?.s2) query.pathname += "/" + encodeURIComponent(id.s2);
    else if (title) {
      query.pathname += "/search";
      query.searchParams.set("query", title);
      query.searchParams.set("limit", "5");
    } else return [];
    const response = await http.json<RawPaper & { data?: RawPaper[] }>(
      query,
      env.S2_API_KEY ? { "x-api-key": env.S2_API_KEY } : undefined,
    );
    return response
      ? (response.data ?? [response]).slice(0, 5).map(mapS2Paper).filter(valid)
      : [];
  }
  async function unpaywall(doi: string) {
    if (!env.UNPAYWALL_EMAIL) return undefined;
    const query = new URL("https://api.unpaywall.org/v2/" + doiPath(doi));
    query.searchParams.set("email", env.UNPAYWALL_EMAIL);
    type UnpaywallLocation = { url_for_pdf?: string; license?: string };
    const result = await http.json<{
      best_oa_location?: UnpaywallLocation;
      oa_locations?: UnpaywallLocation[];
      oa_status?: string;
    }>(query);
    return [result?.best_oa_location, ...(result?.oa_locations ?? [])]
      .map((location) =>
        safeAccess(
          { pdf_url: location?.url_for_pdf, license: location?.license },
          result?.oa_status,
          "unpaywall",
        ),
      )
      .find(Boolean);
  }
  async function core(doi: string): Promise<Access | undefined> {
    if (!env.CORE_API_KEY) return undefined;
    const query = new URL("https://api.core.ac.uk/v3/search/works/");
    query.searchParams.set("q", `doi:"${doi.replace(/["\\]/g, "\\$&")}"`);
    query.searchParams.set("limit", "2");
    const result = await http.json<{
      results?: {
        doi?: string;
        downloadUrl?: string;
        sourceFulltextUrls?: string[];
        license?: string;
      }[];
    }>(query, { authorization: "Bearer " + env.CORE_API_KEY });
    const work = result?.results?.find(
      (w) => w.doi && parsedId(w.doi)?.value === doi,
    );
    const link = [work?.downloadUrl, ...(work?.sourceFulltextUrls ?? [])]
      .map((v) => url(v))
      .find(Boolean);
    return link
      ? { url: link, licence: work?.license, oaStatus: "green", source: "core" }
      : undefined;
  }
  return { openalex, crossref, semantic, unpaywall, core };
}
export type { Resolved, Access };
