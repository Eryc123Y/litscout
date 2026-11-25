/** Existing reports use Markdown headings or bold section labels. Preserve unknown copy. */
export function digestSections(body: string, topics: string[]) {
  const out = { radar: "", picks: "", suggestions: "", notes: "" };
  let section: keyof typeof out = "notes",
    fence = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading =
      !fence && (/^#{1,6}\s+(.+)$/.exec(line) ?? /^\*\*(.+?)\*\*/.exec(line));
    if (heading) {
      const label = heading[1]!.trim();
      section = /radar|雷达/i.test(label)
        ? "radar"
        : /suggestion|idea|建议|想法/i.test(label)
          ? "suggestions"
          : /pick|topic|推荐|主题/i.test(label) ||
              topics.some(
                (topic) => label.toLowerCase() === topic.toLowerCase(),
              )
            ? "picks"
            : "notes";
    }
    out[section] += `${line}\n`;
  }
  return Object.fromEntries(
    Object.entries(out).map(([key, value]) => [key, value.trim()]),
  ) as typeof out;
}
