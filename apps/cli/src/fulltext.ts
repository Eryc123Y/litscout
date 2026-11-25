import { z } from "zod";
import type { FeedItem } from "@litscout/pipeline/contracts/index";
import type { FeedApi } from "@litscout/pipeline/api";
import { fetchPublicPdf, limitedPdf } from "./public-fetch";
export async function fetchRadarText(
  day: string,
  id: string,
  papers: FeedItem[],
  api: FeedApi,
  fetchImpl: typeof fetch,
  maximum: number,
) {
  const paper = papers.find((p) => p.paperId === id);
  if (!paper)
    throw new Error("Full text is restricted to today's radar candidates");
  const name = `fulltext:${day}`,
    stored = z
      .object({ value: z.string() })
      .nullable()
      .parse(await api.get(`/sync/cursors?name=${encodeURIComponent(name)}`));
  const ids = stored ? z.array(z.string()).parse(JSON.parse(stored.value)) : [];
  if (!ids.includes(id) && ids.length >= Math.min(maximum, 2))
    throw new Error("At most two radar papers can be read in full per day");
  const link =
    paper.links.find((l) => l.kind === "pdf_oa") ??
    paper.links.find((l) => l.kind === "pdf_arxiv");
  if (!link)
    return { paperId: id, text: null, reason: "No open-access full text link" };
  const response = await fetchPublicPdf(link.url, fetchImpl);
  if (!response.ok)
    return {
      paperId: id,
      text: null,
      reason: `Full text HTTP ${response.status}`,
    };
  const data = await limitedPdf(response);
  const text = await pdfText(data);
  if (!text.trim())
    return { paperId: id, text: null, reason: "No extractable full text" };
  if (!ids.includes(id))
    await api.write(
      "/ingest/legacy",
      { cursors: [{ name, value: JSON.stringify([...ids, id]) }] },
      10,
    );
  return { paperId: id, text };
}

async function pdfText(data: Uint8Array) {
  // Loaded here, not at start: the PDF library is large and only this reads PDFs.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data, useSystemFonts: true });
  const pdf = await loading.promise;
  let text = "";
  try {
    for (let i = 1; i <= pdf.numPages && text.length < 60000; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      text +=
        content.items.map((t) => ("str" in t ? t.str : "")).join(" ") + "\n";
    }
  } finally {
    await loading.destroy();
  }
  text = text
    .split(/\n\s*(References|REFERENCES|Bibliography)\s*\n/)[0]!
    .slice(0, 60000);
  return text;
}
