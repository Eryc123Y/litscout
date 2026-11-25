import "./validation-csp";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { queryDefaults } from "./query-defaults";
import { preloadMarkdown } from "./Markdown";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./style.css";
const queryClient = new QueryClient(queryDefaults);
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
// The Markdown parser is not in the first script: fetch it once the page
// has painted, before a note or a brief needs it.
const whenIdle: (run: () => void) => void =
  "requestIdleCallback" in globalThis
    ? (run) => globalThis.requestIdleCallback(run, { timeout: 3000 })
    : (run) => setTimeout(run, 1500);
whenIdle(() => void preloadMarkdown());
