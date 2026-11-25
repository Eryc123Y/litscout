import { expect, it } from "vitest";
import { topicOklch } from "../src/topic-colours";

// Independent OKLab -> linear sRGB conversion, with display gamut clipping.
function luminance({ l, c, h }: ReturnType<typeof topicOklch>) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function surfaceLuminance(hex: string) {
  const rgb = hex.match(/\w\w/g)!.map((v) => {
    const s = parseInt(v, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
it("keeps every generated topic readable on light and dark surfaces", () => {
  for (const dark of [false, true]) {
    const background = surfaceLuminance(dark ? "171a20" : "ffffff");
    for (let i = 0; i < 512; i++) {
      const text = luminance(topicOklch(i, dark));
      const ratio =
        (Math.max(text, background) + 0.05) /
        (Math.min(text, background) + 0.05);
      expect(ratio, `topic ${i}, dark=${dark}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});
it("separates adjacent topics in lightness as well as hue, beyond the default eight", () => {
  for (const dark of [false, true]) {
    for (let i = 0; i < 511; i++) {
      const a = topicOklch(i, dark),
        b = topicOklch(i + 1, dark);
      expect(Math.abs(a.l - b.l)).toBeGreaterThan(0.05);
      const distance = Math.abs(a.h - b.h) % 360;
      expect(Math.min(distance, 360 - distance)).toBeGreaterThan(15);
    }
  }
});
