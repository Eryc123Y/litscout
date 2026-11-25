import { defineConfig } from "@litscout/core";

export default defineConfig({
  instance: {
    name: "LitScout",
    // Deploy records the workers.dev origin for CLI and MCP requests.
    // publicUrl: "https://worker.example.workers.dev",
    // Set this to the Access-protected browser origin after adding a custom domain.
    // webUrl: "https://reader.example.com",
    timezone: "UTC", // Set your IANA time zone for the date and cutoff.
    language: "en", // Use "en" or "zh" for summaries and digests.
    // Opt in explicitly to publish paper feeds and topic names.
    publicFeed: false,
  },
  access: {
    // Set both from the private browser application in Cloudflare Access.
    // teamDomain: "your-team.cloudflareaccess.com",
    // aud: "YOUR_ACCESS_AUD",
  },
  sources: {
    // Change the arXiv categories you follow and edit venues.json for venue watch.
    arxiv: { categories: ["cs.CV", "cs.CL"] },
    venues: { watchlist: "./venues.json" },
  },
  // A match in the title or abstract puts a paper on the keyword shortlist.
  topics: [
    {
      name: "Computer vision",
      keywords: ["depth estimation", "3D reconstruction"],
    },
  ],
  agent: {
    // Keyword-only mode works without an agent installation. For summaries and
    // digests, set mode to "client" and choose the client and fallbacks for each.
    mode: "none",
    // summaries: { client: "claude", fallback: [] },
    // digest: { client: "claude", fallback: [] },
  },
  vault: {
    // Optional Obsidian sync. Set root to an existing vault when enabling sync.
    // A missing vault is fine while writes are disabled and you only use the feed.
    // Keep writes disabled until you have reviewed a dry run. Exclude private notes.
    root: "./vault",
    // name: "Research vault", // Obsidian name if different from the folder name
    write: false,
    projects: ["Research/Projects/*.md"],
    exclude: ["**/.*", "**/*NDA*", "Research/Private/**"],
    uploadDescriptions: true,
    paperNotes: {
      // Folder values are vault-relative and the keys must match topic names.
      dirs: { "Computer vision": "Research/Papers" },
      template: "./vault-paper-template.md",
    },
    digestsDir: "LitScout/Digests",
    digestTemplate: "./vault-digest-template.md",
  },
});
