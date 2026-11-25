import { fivePartSchema } from "./contracts/index";
import { z } from "zod";
export type SummaryPaper = { paperId: string; title: string; abstract: string };
export type FivePart = z.output<typeof fivePartSchema>;
const fields = [
  "tldr",
  "motivation",
  "method",
  "result",
  "conclusion",
] as const;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export function formatChunk(papers: readonly SummaryPaper[]) {
  return papers
    .map(
      (p) =>
        `=== ${p.paperId}\ntitle: ${oneLine(p.title)}\nabstract: ${oneLine(p.abstract)}\n`,
    )
    .join("\n");
}
function readFields(lines: string[]) {
  const result: Record<string, string> = {};
  let last: string | null = null;
  for (const line of lines.filter((l) => l.trim())) {
    const m = line.match(/^[\s>*_`#-]*([A-Za-z]+)[*_`]*\s*[:：]\s*(.*)$/);
    const key = m?.[1]?.toLowerCase();
    if (key && fields.includes(key as (typeof fields)[number])) {
      result[key] = m![2]!.trim();
      last = key;
    } else if (last) result[last] = `${result[last]} ${line.trim()}`.trim();
  }
  return result;
}
function inlineFields(lines: string[]) {
  const text = lines
    .filter((l) => l.trim())
    .map((l) => l.trim())
    .join(" ");
  const seen = new Set<string>();
  const labels = [
    ...text.matchAll(
      /(?<![A-Za-z])[*_`]*(tldr|motivation|method|result|conclusion)[*_`]*\s*[:：]/gi,
    ),
  ].filter((m) => {
    const key = m[1]!.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return Object.fromEntries(
    labels.map((m, i) => [
      m[1]!.toLowerCase(),
      text
        .slice(m.index! + m[0].length, labels[i + 1]?.index ?? text.length)
        .trim(),
    ]),
  );
}
export function parseBlocks(text: string) {
  const blocks: { id: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^===\s*(\S+)\s*$/);
    if (m) blocks.push({ id: m[1]!, lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  const summaries: Record<string, FivePart> = {},
    problems: string[] = [];
  for (const { id, lines } of blocks) {
    const first = fivePartSchema.safeParse(readFields(lines));
    const parsed = first.success
      ? first
      : fivePartSchema.safeParse(inlineFields(lines));
    if (!parsed.success) problems.push(`${id}: incomplete block`);
    else if (summaries[id]) problems.push(`${id}: duplicate block ignored`);
    else summaries[id] = parsed.data;
  }
  return { summaries, problems };
}
export type SummaryMath = "plain" | "tex";
/**
 * Set only after cutover: the shadow run keeps the old prompt byte for byte.
 * The reader shows sub- and superscripts, Greek letters and common symbols.
 */
const texRule =
  " Formulas are the exception: write them as inline TeX between single dollar signs, such as $O(d^{p/(2p+2)})$ or $\\ell_2$, kept short, using sub- and superscripts, Greek letters and common symbols.";
export function instructions(language: string, math: SummaryMath = "plain") {
  const guide = {
    tldr: "one or two sentences: what the paper does and what it finds",
    motivation: "the problem addressed and what existing work lacks",
    method: "the core approach and its key design choices",
    result: "the main findings, keeping key numbers, datasets and baselines",
    conclusion: "the takeaway and its significance",
  };
  return (
    "You are a professional paper analyst. Summarise a research paper from its title " +
    `and abstract in ${language}, filling five fields:\n${Object.entries(guide)
      .map(([name, detail]) => `- ${name}: ${detail}`)
      .join("\n")}\n\n` +
    "Be concise, specific and precise, with correct terminology. Use only what the abstract states; do not invent numbers or claims. Keep names of models, datasets, metrics and established technical terms in their original form where that is clearer. Plain text only: no Markdown, no line breaks inside a field." +
    (math === "tex" ? texRule : "")
  );
}
export function subagentInstructions(
  language: string,
  math: SummaryMath = "plain",
) {
  return `# Summarise papers\n\n${instructions(language, math)}\n\n## Input\nThe input file holds one block per paper: a line \`=== <paper id>\`, then a \`title:\` line and an \`abstract:\` line.\n\n## Output\nUse the Write tool to write the output file with one block per input paper, in input order, exactly in this format:\n\n=== <paper id>\n${fields.map((f) => `${f}: ...`).join("\n")}\n\nRules:\n- Every paper in the input gets a block. Copy each \`=== <paper id>\` line exactly.\n- Field names stay in English as shown; field contents are in ${language}.\n- Each field is a single line. No Markdown, no blank fields, nothing else in the file.\n\nWhen the file is written, reply with only: done <number of blocks written>\n`;
}
