// @vitest-environment jsdom
import { createElement, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Markdown } from "../src/Markdown";
import { MarkdownEditor } from "../src/MarkdownEditor";
import { hasMath } from "../src/math-markdown";
import { loadMath } from "../src/math-render";

// `$...$` and `$$...$$` render as MathML wherever Markdown shows. The math
// library loads on demand; until then, and whenever TeX is invalid, the raw
// source stays visible. Prices and code keep their dollars.
afterEach(cleanup);

const show = (text: string, gfm = true) =>
  render(createElement(Markdown, { text, gfm })).container;

it("shows the raw TeX until the math library has loaded", async () => {
  const container = show("Energy $E=mc^2$ here.");
  expect(container.textContent).toBe("Energy $E=mc^2$ here.");
  expect(container.querySelector("math")).toBeNull();
  await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
  expect(container.textContent).not.toContain("$");
});

it("renders inline math as MathML inside the paragraph", async () => {
  await loadMath();
  const container = show("Loss $\\ell_p$ and $x^2 + \\frac{a}{b}$ apply.");
  await waitFor(() =>
    expect(container.querySelectorAll("p math")).toHaveLength(2),
  );
  const first = container.querySelector("math")!;
  expect(first.getAttribute("display")).toBeNull();
  expect(container.querySelector("msub")).not.toBeNull();
  expect(container.querySelector("mfrac")).not.toBeNull();
});

it("renders $$ blocks and inline $$ as display math", async () => {
  await loadMath();
  const container = show(
    "Sum:\n\n$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\nAnd $$a=b$$ too.",
  );
  await waitFor(() =>
    expect(container.querySelectorAll('math[display="block"]')).toHaveLength(2),
  );
  expect(container.querySelector("div.math-display math")).not.toBeNull();
  expect(container.querySelector("p span.math-display math")).not.toBeNull();
});

it("renders math in the digest's plain Markdown too", async () => {
  await loadMath();
  const container = show("Gain of $\\alpha$ over baseline.", false);
  await waitFor(() => expect(container.querySelector("math")).not.toBeNull());
});

it("leaves prices and digit-only spans as text", async () => {
  await loadMath();
  for (const text of [
    "It costs $5 and $10 a month.",
    "Pay $5$ now.",
    "From $5-$10 each.",
    "A $ x$ gap and $y $ gap.",
  ]) {
    const container = show(text);
    expect(container.querySelector("math")).toBeNull();
    expect(container.textContent).toBe(text);
    cleanup();
  }
});

it("keeps dollars in code spans and fences", async () => {
  await loadMath();
  const container = show("Use `$x$` inline.\n\n```\nprice = $a$\n```");
  expect(container.querySelector("math")).toBeNull();
  expect(container.querySelector("p code")!.textContent).toBe("$x$");
  expect(container.querySelector("pre code")!.textContent).toBe(
    "price = $a$\n",
  );
});

it("falls back to the raw TeX when it does not parse", async () => {
  await loadMath();
  const container = show("Broken $\\frac{a$ and $\\nosuchcommand$ stay.");
  // Give the renderer a chance before asserting nothing was rendered.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.querySelector("math")).toBeNull();
  expect(container.textContent).toBe(
    "Broken $\\frac{a$ and $\\nosuchcommand$ stay.",
  );
});

it("keeps sanitising: no scripts, javascript: links or style attributes", async () => {
  await loadMath();
  const container = show(
    [
      "<script>alert(1)</script>",
      "[bad](javascript:alert(1)) and $\\color{red}{x}$ and",
      "$\\href{javascript:alert(1)}{y}$",
      "",
      "$$\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}$$",
    ].join("\n"),
  );
  await waitFor(() => expect(container.querySelector("mtable")).not.toBeNull());
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("[style]")).toBeNull();
  expect(container.querySelector("[href^='javascript']")).toBeNull();
  // \href is refused, so its source stays as text, never as an attribute.
  const attributes = Array.from(container.querySelectorAll("*")).flatMap(
    (element) => Array.from(element.attributes, (a) => a.value),
  );
  expect(attributes.some((value) => value.includes("javascript"))).toBe(false);
  expect(container.textContent).toContain("\\href{javascript:alert(1)}{y}");
});

it("detects math cheaply before loading anything", () => {
  expect(hasMath("Energy $E=mc^2$")).toBe(true);
  expect(hasMath("$$\n\\int f\n$$")).toBe(true);
  expect(hasMath("No math here.")).toBe(false);
  expect(hasMath("It costs $5 and $10.")).toBe(false);
});

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return createElement(MarkdownEditor, {
    label: "Body",
    value,
    onChange: setValue,
    maxLength: 1000,
  });
}

it("previews live under the textarea while typing, Write and Preview kept", async () => {
  await loadMath();
  render(createElement(Harness, { initial: "" }));
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Body",
  });
  expect(box.hidden).toBe(false);
  expect(screen.getByRole("radio", { name: "Both" }).dataset.state).toBe("on");
  const preview = screen.getByRole("region", { name: "Preview" });
  fireEvent.change(box, { target: { value: "**bold** and $x^2$" } });
  await waitFor(() => expect(preview.querySelector("strong")).not.toBeNull());
  await waitFor(() => expect(preview.querySelector("math")).not.toBeNull());
  fireEvent.change(box, { target: { value: "**bolder**" } });
  await waitFor(() =>
    expect(preview.querySelector("strong")!.textContent).toBe("bolder"),
  );

  fireEvent.click(screen.getByRole("radio", { name: "Write" }));
  expect(screen.queryByRole("region", { name: "Preview" })).toBeNull();
  expect(box.hidden).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(box.hidden).toBe(true);
  expect(screen.getByRole("region", { name: "Preview" })).toBeTruthy();
});
