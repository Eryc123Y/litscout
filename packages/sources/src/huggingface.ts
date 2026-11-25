import { z } from "zod";
const entry = z.object({
  paper: z
    .object({ id: z.string().optional(), upvotes: z.number().optional() })
    .nullable()
    .optional(),
});
export type HfEntry = z.infer<typeof entry>;
export function hfUpvotes(lists: readonly (readonly HfEntry[])[]) {
  const result: Record<string, number> = {};
  for (const list of lists)
    for (const item of list) {
      const p = item.paper;
      if (p?.id && Number.isInteger(p.upvotes))
        result[p.id] = Math.max(p.upvotes!, result[p.id] ?? 0);
    }
  return result;
}
export async function readHuggingFace(
  day: string,
  fetchImpl = fetch,
  now = () => new Date(),
): Promise<HfEntry[]> {
  z.iso.date().parse(day);
  const response = await fetchImpl(
    `https://huggingface.co/api/daily_papers?date=${day}&limit=100`,
    { signal: AbortSignal.timeout(30000) },
  );
  // Hugging Face answers 400 for a date it has not opened yet, which for
  // some hours after 00:00 UTC includes the new UTC date: no papers yet.
  if (response.status === 400 && day >= now().toISOString().slice(0, 10))
    return [];
  if (!response.ok) throw new Error(`Hugging Face HTTP ${response.status}`);
  const value: unknown = await response.json();
  return Array.isArray(value)
    ? value.flatMap((v) => {
        const p = entry.safeParse(v);
        return p.success ? [p.data] : [];
      })
    : [];
}
