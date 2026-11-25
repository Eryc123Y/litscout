// @vitest-environment jsdom
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Settings } from "../src/Settings";

afterEach(cleanup);

it("styles the Your data links as links", () => {
  render(
    createElement(
      MemoryRouter,
      null,
      createElement(Settings, {
        prefs: { mode: "system" },
        onChange: vi.fn(),
        topics: [],
      }),
    ),
  );
  for (const name of ["Vault sync", "Health"]) {
    const link = screen.getByRole("link", { name });
    expect(link.className).toContain("text-primary");
    expect(link.className).not.toContain("text-subtle");
  }
});
