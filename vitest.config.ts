import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL(
          "./packages/core/test/stubs/cloudflare-workers.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    maxWorkers: 4,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    setupFiles: ["./packages/core/test/setup.ts"],
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    projects: [
      {
        extends: true,
        test: {
          name: "pipeline",
          include: ["packages/pipeline/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "core",
          include: ["packages/core/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "mcp",
          include: ["packages/mcp/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["packages/db/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "sources",
          include: ["packages/sources/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "sync",
          include: ["packages/sync/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "i18n",
          include: ["packages/i18n/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          include: ["apps/web/test/**/*.test.ts"],
          // Added to the shared setup file, not in place of it.
          setupFiles: ["./apps/web/test/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "cli",
          include: ["apps/cli/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          include: ["apps/server/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "worker",
          include: ["apps/worker/test/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "tools",
          include: ["tools/test/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      // Vendored shadcn primitives are exercised through the reader, not measured
      // as product logic. Keep the existing app and package thresholds unchanged.
      exclude: ["apps/web/src/components/ui/**"],
      include: ["{apps,packages}/*/src/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary", "json"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        "apps/web/src/**": {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80,
        },
        "packages/core/src/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        "packages/db/src/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        "packages/sync/src/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
        "packages/pipeline/src/contracts/**": {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
