/** The reference's topic hues, followed by the existing golden-angle generator. */
const hues = [190, 250, 275, 150, 45, 310, 90, 350];
export function topicOklch(index: number, dark = false) {
  const i = Math.max(0, Math.floor(index));
  return {
    l: dark ? (i % 2 ? 0.85 : 0.76) : i % 2 ? 0.515 : 0.46,
    c: 0.1,
    h: hues[i] ?? (205 + i * 137.508) % 360,
  };
}
export function topicColour(index: number) {
  const { c, h } = topicOklch(index);
  return `oklch(var(--topic-l-${index % 2 ? "b" : "a"}) ${c} ${h})`;
}
/** CSSOM properties preserve CSP: React never emits a style attribute. */
export function applyTopicColour(element: HTMLElement | null, index: number) {
  element?.style.setProperty("--topic-colour", topicColour(index));
}
