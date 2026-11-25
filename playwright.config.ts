import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "apps/web/e2e",
  outputDir: ".artifacts/playwright",
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: ".artifacts/playwright-results.json" }],
  ],
  // Animations are off in tests unless a test turns them on (motion.spec.ts),
  // so screenshots and contrast checks never catch an element mid-fade.
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "phone",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm web:local",
    wait: { stdout: /Local fixture Worker ready:/ },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    timeout: 90_000,
    reuseExistingServer: false,
  },
});
