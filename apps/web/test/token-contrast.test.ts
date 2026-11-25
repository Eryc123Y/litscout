import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { topicOklch } from "../src/topic-colours";

const source = readFileSync(
  new URL("../src/style.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
const palettes = ["journal", "graphite", "system-light", "system-dark"];
function tokens(palette: string) {
  const vars: Record<string, string> = {};
  for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const rule = selector!.trim();
    if (
      rule !== ":root" &&
      !rule.includes(`[data-theme="${palette}"]`) &&
      !(palette === "system-dark" && rule === ":root:not([data-theme])")
    )
      continue;
    for (const [, key, value] of body!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      vars[key!] = value!.trim();
  }
  return vars;
}
function luminance(hex: string) {
  const raw = hex.replace(/^#/, "");
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(raw))
    throw Error(`Unrecognised token colour: ${hex}`);
  const rgb = (raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw)
    .match(/../g)!
    .map((value) => {
      const c = parseInt(value, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
function topicLuminance(index: number, vars: Record<string, string>) {
  const { c, h } = topicOklch(index),
    l = Number(vars[`--topic-l-${index % 2 ? "b" : "a"}`]);
  const a = c * Math.cos((h * Math.PI) / 180),
    b = c * Math.sin((h * Math.PI) / 180);
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ].map((value) => {
    const linear = Math.max(0, Math.min(1, value));
    const encoded =
      linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * linear ** (1 / 2.4) - 0.055;
    // Match the browser flow's Canvas getImageData 8-bit sRGB readback.
    const c = Math.round(encoded * 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
it.each(palettes)(
  "%s text tokens reach 4.5:1 on every reader surface",
  (palette) => {
    const vars = tokens(palette);
    const surfaces = ["--surface", "--ground", "--soft", "--radar-soft"];
    const text = [
      "--ink",
      "--subtle",
      "--muted",
      "--accent",
      "--radar",
      "--error",
    ];
    for (const surface of surfaces) {
      const background = luminance(vars[surface]!);
      for (const token of text)
        expect(
          contrast(luminance(vars[token]!), background),
          `${palette} ${token} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      for (let i = 0; i < 512; i++)
        expect(
          contrast(topicLuminance(i, vars), background),
          `${palette} topic ${i} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
    }
    // Filled actions and the inverse brand mark use their own foregrounds.
    expect(
      contrast(luminance(vars["--accent-ink"]!), luminance(vars["--accent"]!)),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(luminance(vars["--error-ink"]!), luminance(vars["--error"]!)),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(luminance(vars["--surface"]!), luminance(vars["--ink"]!)),
    ).toBeGreaterThanOrEqual(4.5);
  },
);
it.each(["journal", "graphite"])(
  "%s status, focus and outline tokens are readable",
  (palette) => {
    const vars = tokens(palette);
    const on = (fg: string, bg: string) =>
      contrast(luminance(vars[fg]!), luminance(vars[bg]!));
    // Non-text marks that carry meaning need 3:1 against the page (WCAG 1.4.11).
    for (const mark of ["--accent", "--good", "--missed", "--line-strong"])
      for (const surface of ["--ground", "--surface"])
        expect(
          on(mark, surface),
          `${palette} ${mark} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
    // Every status fill has a glyph colour that reads on it, and each soft
    // status chip has readable text.
    for (const state of ["good", "late", "missed"]) {
      expect(
        on(`--on-${state}`, `--${state}`),
        `${palette} ${state} glyph`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        on(`--${state}-text`, `--${state}-soft`),
        `${palette} ${state} chip`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // Controls and the selected row stay visibly apart from the card they sit on.
    for (const fill of ["--control", "--pressed", "--row-on"])
      expect(
        on("--ink", fill),
        `${palette} ink on ${fill}`,
      ).toBeGreaterThanOrEqual(4.5);
  },
);
