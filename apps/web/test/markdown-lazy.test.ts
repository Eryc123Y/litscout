// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.resetModules();
});

it("shows the text at once and renders it as Markdown when the parser has loaded", async () => {
  // A fresh copy of the module: the parser is not loaded yet.
  vi.resetModules();
  const { Markdown } = await import("../src/Markdown");
  const { container } = render(
    createElement(Markdown, { text: "Read the **depth** papers." }),
  );
  // Before the parser arrives the words are already readable.
  expect(container.textContent).toContain("Read the **depth** papers.");
  expect(container.querySelector("strong")).toBeNull();
  expect((await screen.findByText("depth")).tagName).toBe("STRONG");
  expect(container.textContent).not.toContain("**");
});

it("renders at once after a preload", async () => {
  vi.resetModules();
  const { Markdown, preloadMarkdown } = await import("../src/Markdown");
  await preloadMarkdown();
  render(createElement(Markdown, { text: "A *ready* parser." }));
  expect(screen.getByText("ready").tagName).toBe("EM");
});
