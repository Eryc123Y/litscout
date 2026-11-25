import { configure } from "@testing-library/react";

// Secondary pages load on demand (M4o). Their first import can take longer
// than the 1 s default on a busy machine, so async queries wait up to 5 s.
configure({ asyncUtilTimeout: 5_000 });

// The Markdown parser loads on demand in the app; tests start with it
// loaded so they can assert on rendered Markdown without waiting.
const { preloadMarkdown } = await import("../src/Markdown");
await preloadMarkdown();
