// @vitest-environment jsdom
import { createElement } from "react";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { MathText, plainMath } from "../src/math-text";

const html = (text: string) =>
  render(createElement(MathText, { text })).container.innerHTML;

it("drops the dollar delimiters and keeps the words around inline math", () => {
  expect(html("Robust $k$-center clustering")).toBe(
    "Robust k-center clustering",
  );
  expect(html("$\\beta$-models for graphs")).toBe("β-models for graphs");
  expect(html("Accuracy$\\unicode{8211}$efficiency trade-offs")).toBe(
    "Accuracy–efficiency trade-offs",
  );
});

it("renders superscripts and subscripts as sup and sub", () => {
  expect(html("A$^3$: adaptive agents")).toBe("A<sup>3</sup>: adaptive agents");
  expect(html("RL$^{\\mathrm{RT}}$ runtime")).toBe("RL<sup>RT</sup> runtime");
  expect(html("Optimisation in $\\ell_p$ geometries")).toBe(
    "Optimisation in ℓ<sub>p</sub> geometries",
  );
  expect(html("Surface CO$_2$ flux")).toBe("Surface CO<sub>2</sub> flux");
  expect(html("Models of $x_{1:n-1}$ and $\\mathbb{R}^d$")).toBe(
    "Models of x<sub>1:n-1</sub> and ℝ<sup>d</sup>",
  );
});

it("leaves prices, escaped dollars and unmatched dollars as written", () => {
  for (const text of [
    "Costs $5 and $10 per run",
    "An escaped \\$ sign",
    "One $ alone",
    "Spaced $ x $ delimiters",
  ])
    expect(html(text)).toBe(text.replaceAll("&", "&amp;"));
});

it("never turns math into markup it was not given", () => {
  expect(html("$<script>x</script>$ and $a<b$")).toBe(
    "&lt;script&gt;x&lt;/script&gt; and a&lt;b",
  );
});

it("gives a plain-text form for labels and document titles", () => {
  expect(plainMath("A$^3$ and CO$_2$ in $\\ell_p$")).toBe("A³ and CO₂ in ℓₚ");
  expect(plainMath("RL$^{\\mathrm{RT}}$")).toBe("RLᴿᵀ");
  expect(plainMath("$x^{\\alpha+1}$")).toBe("x^(α+1)");
  expect(plainMath("Costs $5 and $10")).toBe("Costs $5 and $10");
});

it("splits a plain-text abstract into paragraphs without reading Markdown", async () => {
  const { MathParagraphs } = await import("../src/math-text");
  const { container } = render(
    createElement(MathParagraphs, {
      text: "We bound $x_n$ in *every* case\nand line.\n\nCode at https://example.org/a_b_c.",
    }),
  );
  expect(container.innerHTML).toBe(
    '<div class="markdown"><p>We bound x<sub>n</sub> in *every* case and line.</p><p>Code at https://example.org/a_b_c.</p></div>',
  );
});

it("takes a whole command as a script argument", () => {
  expect(html("$x^\\alpha$ and $\\ell^\\infty$ and $f_\\theta$")).toBe(
    "x<sup>α</sup> and ℓ<sup>∞</sup> and f<sub>θ</sub>",
  );
  expect(html("$A^\\top$ and $L^{\\star}$ and $g^\\prime$")).toBe(
    "A<sup>⊤</sup> and L<sup>⋆</sup> and g<sup>′</sup>",
  );
  expect(html("$x^\\mathrm{RT}$")).toBe("x<sup>RT</sup>");
});

it("keeps a span with an unknown command exactly as written", () => {
  for (const text of [
    "Rates of $\\frac{1}{2}$ order",
    "Roots $\\sqrt{n}$ here",
    "Pairs $\\left(x\\right)$ there",
  ])
    expect(html(text)).toBe(text);
  expect(plainMath("Rates of $\\frac{1}{2}$")).toBe("Rates of $\\frac{1}{2}$");
});

it("handles escaped backslashes, double dollars and astral characters", () => {
  expect(html("Path $a\\\\$ end")).toBe("Path a end");
  expect(html("Display $$x$$ math")).toBe("Display $$x$$ math");
  expect(html("Emoji $x^😀$ power")).toBe("Emoji x<sup>😀</sup> power");
});

it("accepts only decimal code points outside bidi controls in \\unicode", () => {
  expect(html("A$\\unicode{8211}$B")).toBe("A–B");
  expect(html("A$\\unicode{0x41}$B")).toBe("A$\\unicode{0x41}$B");
  expect(html("A$\\unicode{8238}$B")).toBe("A$\\unicode{8238}$B");
  expect(html("A$\\unicode{8295}$B")).toBe("A$\\unicode{8295}$B");
});
