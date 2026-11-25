import { z } from "zod";
export const topicSchema = z.object({
  name: z.string().min(1),
  keywords: z.array(z.string()),
  color: z.string().optional(),
});
export type Topic = z.infer<typeof topicSchema>;
export type TopicPaper = {
  title?: string;
  summary?: string;
  AI?: { tldr?: string };
};
const separator = "[\\s\\-‐-—_/]+";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function termPattern(term: string) {
  const words = term.trim().split(new RegExp(separator)).filter(Boolean);
  if (!words.length) return null;
  const first = words[0]!;
  const name =
    words.length === 1 &&
    /\p{Lu}/u.test(first[0]!) &&
    /\p{Ll}/u.test(first.slice(1));
  if (name) return `${escape(first)}(?:e?s)?`;
  return (
    words
      .map((word) =>
        [...word]
          .map((c) => {
            const lower = c.toLowerCase(),
              upper = c.toUpperCase();
            return lower !== upper && lower.length === 1 && upper.length === 1
              ? `[${escape(lower)}${escape(upper)}]`
              : escape(c);
          })
          .join(""),
      )
      .join(separator) + "(?:[eE]?[sS])?"
  );
}
export function keywordMatches(text: string, keyword: string) {
  const pattern = termPattern(keyword);
  return Boolean(
    text &&
    pattern &&
    new RegExp(`(^|[^A-Za-z0-9])(${pattern})(?![A-Za-z0-9])`).test(text),
  );
}
export function topicsFor(record: TopicPaper, topics: readonly Topic[]) {
  const text = [record.title, record.summary, record.AI?.tldr]
    .filter(Boolean)
    .join(" ");
  return topics
    .filter((t) => t.keywords.some((k) => keywordMatches(text, k)))
    .map((t) => t.name);
}
/** Read data literals only; never execute the reference JS. Same extraction as interests.py. */
export function importTopics(source: string): Topic[] {
  const body = source.split("const TOPICS")[1]?.split("];")[0];
  if (!body) throw new Error("Expected const TOPICS in interest presets");
  return z
    .array(topicSchema)
    .min(1)
    .parse(
      [...body.matchAll(/name:\s*'([^']+)',\s*keywords:\s*\[(.*?)\]/gs)].map(
        (m) => ({
          name: m[1],
          keywords: [...m[2]!.matchAll(/'([^']+)'/g)].map((q) => q[1]),
        }),
      ),
    );
}
