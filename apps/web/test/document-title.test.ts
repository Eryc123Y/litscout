// @vitest-environment jsdom
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { pageTitle, useDocumentTitle } from "../src/useDocumentTitle";

afterEach(cleanup);

it("names each page in the browser tab", () => {
  expect(pageTitle("/app/today")).toBe("Today · LitScout");
  expect(pageTitle("/app")).toBe("Today · LitScout");
  expect(pageTitle("/public/today")).toBe("Today · LitScout");
  expect(pageTitle("/")).toBe("Today · LitScout");
  expect(pageTitle("/app/days/2026-11-20")).toBe("Fri 20 Nov · LitScout");
  expect(pageTitle("/public/days/2026-11-17")).toBe("Tue 17 Nov · LitScout");
  expect(pageTitle("/app/days")).toBe("Days · LitScout");
  expect(pageTitle("/app/library")).toBe("Library · LitScout");
  expect(pageTitle("/app/trends")).toBe("Trends · LitScout");
  expect(pageTitle("/app/projects")).toBe("Projects · LitScout");
  expect(pageTitle("/app/ideas")).toBe("Ideas · LitScout");
  expect(pageTitle("/app/working-papers/wp_1")).toBe(
    "Working papers · LitScout",
  );
  expect(pageTitle("/app/vault")).toBe("Vault sync · LitScout");
  expect(pageTitle("/app/health")).toBe("Health · LitScout");
  expect(pageTitle("/app/settings")).toBe("Settings · LitScout");
  expect(pageTitle("/app/nowhere")).toBe("Page not found · LitScout");
  expect(pageTitle("/app/papers/pap_a")).toBe("Paper · LitScout");
});

it("uses the open paper's title, in plain text, and goes back on close", () => {
  const client = new QueryClient();
  client.setQueryData(["paper", false, "2026-11-20", "pap_a", "arxiv"], {
    paperId: "pap_a",
    title: "Depth from $x^2$ views",
  });
  let go: ReturnType<typeof useNavigate> = () => undefined;
  function Probe() {
    useDocumentTitle();
    go = useNavigate();
    return null;
  }
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/app/days/2026-11-20?paper=pap_a"] },
        createElement(Probe),
      ),
    ),
  );
  expect(document.title).toBe("Depth from x² views · LitScout");
  act(() => void go("/app/days/2026-11-20"));
  expect(document.title).toBe("Fri 20 Nov · LitScout");
  act(() => void go("/app/library?panel=paper%3Apap_a"));
  expect(document.title).toBe("Depth from x² views · LitScout");
  act(() => void go("/app/papers/pap_b"));
  expect(document.title).toBe("Paper · LitScout");
  // The title follows the paper once it loads.
  act(() =>
    client.setQueryData(["paper", false, undefined, "pap_b", undefined], {
      paperId: "pap_b",
      title: "Second paper",
    }),
  );
  expect(document.title).toBe("Second paper · LitScout");
  cleanup();
  expect(document.title).toBe("LitScout");
});
