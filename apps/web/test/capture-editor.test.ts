// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CaptureDialog } from "../src/IdeaActions";
afterEach(cleanup);

it("writes a capture in Markdown with a preview and a character count", () => {
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(CaptureDialog, {}),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Capture idea" }));
  const body = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Note (Markdown, optional)",
  });
  expect(body.maxLength).toBe(10_000);
  fireEvent.change(body, { target: { value: "## Plan\n\n- **first** step" } });
  expect(screen.getByText("25 / 10,000")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(screen.getByRole("region", { name: "Preview" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
  expect(screen.getByText("first").tagName).toBe("STRONG");
  fireEvent.click(screen.getByRole("radio", { name: "Write" }));
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Note (Markdown, optional)",
    }).value,
  ).toBe("## Plan\n\n- **first** step");
});
