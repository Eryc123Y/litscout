import { z } from "zod";
import { runWatch, type WatchDeps } from "./run";
export const feedLineSchema = z.object({
  source: z.enum([
    "openalex",
    "crossref",
    "openreview",
    "acl-anthology",
    "pmlr",
    "datacite",
    "jmlr",
  ]),
  title: z.string(),
  authors: z.array(z.string()),
  abstract: z.string().nullable(),
  venue: z.string(),
  published: z.iso.date(),
  doi: z.string().nullable(),
  arxiv_id: z.string().nullable(),
  openreview_id: z.string().nullable(),
  oa_url: z.string().nullable(),
  url: z.url(),
});
/** The same watch implementation, with typed values instead of stdout. */
export async function watchVenues(
  argv: readonly string[],
  deps: Omit<WatchDeps, "stdout">,
) {
  const lines: z.infer<typeof feedLineSchema>[] = [];
  const errors: unknown[] = [];
  const code = await runWatch(argv, {
    ...deps,
    onWarning: (message, error) => {
      if (error) errors.push(error);
      deps.onWarning?.(message, error);
    },
    onError: (error) => {
      errors.push(error);
      deps.onError?.(error);
    },
    stdout: (text) => lines.push(feedLineSchema.parse(JSON.parse(text))),
  });
  if (code) throw errors.at(-1) ?? new Error(`Venue watch failed (${code})`);
  return lines;
}
