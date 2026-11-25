import { test, expect } from "@playwright/test";
import { shiftDay } from "@litscout/pipeline/daily";
import { healthSchema } from "@litscout/pipeline/health-contracts";

// Opt in from the dedicated CI step or a local desktop design pass.
test("desktop artboards for review", async ({ page }, testInfo) => {
  test.skip(
    process.env.LITSCOUT_SCREENSHOTS !== "1" ||
      testInfo.project.name !== "desktop",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  const capture = async (name: string, anchor?: string) => {
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 }),
    ).toHaveCount(1);
    await page.evaluate(async (regionName) => {
      await document.fonts.ready;
      const region =
        regionName &&
        document.querySelector(`section[aria-label="${regionName}"]`);
      if (region) region.scrollIntoView();
      else window.scrollTo(0, 0);
    }, anchor);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(1440);
    const path = testInfo.outputPath(`review-${name}.png`);
    await page.screenshot({
      path,
      fullPage: false,
      scale: "css",
      animations: "disabled",
    });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  await page.clock.setSystemTime(new Date("2026-11-10T04:00:00Z"));
  await page.goto("/app/today");
  await expect(
    page.getByRole("region", { name: "Picks per topic" }).getByRole("link"),
  ).toHaveCount(10);
  await expect(
    page
      .getByRole("region", { name: "Idea suggestions" })
      .getByRole("heading", { level: 4 }),
  ).toHaveCount(3);
  await capture("today");

  await page.clock.setSystemTime(new Date("2026-11-17T04:00:00Z"));
  await page.goto("/app/today");
  await expect(
    page.getByRole("region", { name: "Morning brief" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Read Beyond the Black Patch/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeVisible();
  await capture("today-reading", "Papers");
  const suggestions = page.getByRole("region", { name: "Idea suggestions" });
  await expect(suggestions.getByRole("article")).toHaveCount(3);
  await suggestions
    .getByRole("button", { name: "Show 1 more suggestion" })
    .click();
  const fewer = suggestions.getByRole("button", {
    name: "Show fewer suggestions",
  });
  await expect(fewer).toHaveAttribute("aria-expanded", "true");
  await expect(suggestions.getByRole("article")).toHaveCount(4);
  await fewer.click();
  await expect(suggestions.getByRole("article")).toHaveCount(3);
  await page.getByRole("link", { name: "Open full record" }).click();
  await expect(
    page.getByRole("heading", { name: "Identifiers and links" }),
  ).toBeVisible();
  await expect(
    page.getByText("Matched by title", { exact: true }),
  ).toBeVisible();
  await capture("paper");
  await page.goto("/app/days");
  await expect(page.getByRole("region", { name: "Calendar" })).toBeVisible();
  await capture("days");
  await page.goto("/app/trends?month=2026-11&topic=Vision");
  await expect(
    page.getByRole("heading", { name: "Recurring terms" }),
  ).toBeVisible();
  await capture("trends");
  await page.route("**/api/v1/operations/health", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: healthSchema.parse({
          timezone: "Asia/Shanghai",
          onTimeBy: "11:30",
          // Started before the window, so every day counts.
          firstRunDay: "2026-09-01",
          days: Array.from({ length: 30 }, (_, index) => {
            const day = shiftDay("2026-11-16", index - 29);
            const noListing = [0, 6].includes(new Date(day).getUTCDay());
            const status = noListing
              ? "no-listing"
              : index === 22
                ? "missed"
                : index % 5 === 0
                  ? "late"
                  : "on-time";
            return {
              day,
              status,
              reported: !noListing && index !== 22,
              digestAt:
                noListing || status === "missed"
                  ? null
                  : day + (status === "late" ? "T05:25:00Z" : "T03:10:00Z"),
            };
          }),
          runs: [
            {
              id: "43d91359-fbdc-4047-a843-30e90031a4df",
              startedAt: "2026-11-17T04:00:00.000Z",
              targetDay: "2026-11-17",
              finishedAt: null,
              steps: null,
              rowsWritten: null,
            },
            {
              id: "ccae65f9-c16a-4c6c-acc5-70d867ac23c1",
              startedAt: "2026-11-17T02:20:00.000Z",
              targetDay: "2026-11-17",
              finishedAt: "2026-11-17T03:10:00.000Z",
              rowsWritten: 14320,
              steps: {
                fetch: { status: "done" },
                summaries: { status: "done", client: "codex", fallback: true },
                digest: { status: "done", client: "claude" },
                sync: { status: "done" },
                legacy: { status: "skipped" },
              },
            },
          ],
          budget: {
            used: 14320,
            reserved: 1200,
            limit: 80000,
            resetAt: "2026-11-18T00:00:00Z",
            rowsRead: 317,
          },
          storage: {
            sizeBytes: 28410000,
            feedItems: 8233,
            summaries: 7824,
            vaultNotes: 147,
          },
          links: { unchecked: 200, capped: true },
          mirror: {
            activeAt: "2026-11-16T12:42:00Z",
            completedAt: "2026-11-16T12:42:00Z",
          },
        }),
      },
    }),
  );
  await page.goto("/app/health");
  await expect(
    page.getByRole("heading", { name: "Digest delivery" }),
  ).toBeVisible();
  await capture("health");

  await page.goto("/app/days/2026-11-17");
  await expect(
    page.getByRole("button", { name: /Read Beyond the Black Patch/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Idea suggestions" })
      .getByRole("article")
      .first(),
  ).toBeVisible();
  await capture("day");

  await page.goto("/app/library");
  await expect(
    page.getByRole("link", { name: /Forcing a Letter Suppresses Refusal/ }),
  ).toBeVisible();
  await capture("library");
  await page.goto("/app/projects");
  await expect(
    page.getByRole("link", { name: /^PRIVATE_Vision project/ }),
  ).toBeVisible();
  await capture("projects");
  await page.goto("/app/ideas");
  await expect(
    page.getByRole("heading", { name: "PRIVATE_Depth idea" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "PRIVATE_Queued capture" }),
  ).toBeVisible();
  await capture("ideas");

  await page.goto("/app/working-papers");
  const draft = page.getByRole("link", {
    name: "PRIVATE_Depth draft",
    exact: true,
  });
  await expect(draft).toBeVisible();
  await capture("working-papers");
  await draft.click();
  await expect(
    page.getByRole("heading", { name: "PRIVATE_Depth draft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add to reading list" }).first(),
  ).toBeVisible();
  await capture("working-paper");

  await page.goto("/app/vault");
  await expect(page.getByText("Vault writes are off")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Needs review" }),
  ).toBeVisible();
  await capture("vault-sync");

  await page.goto("/app/settings");
  await expect(
    page.getByRole("radiogroup", { name: "Appearance" }),
  ).toBeVisible();
  await capture("settings");

  await page.getByRole("radio", { name: "Dark" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await capture("settings-dark");
  await page.getByRole("radio", { name: "Follow the system" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "journal");

  await page.goto("/public/days/2026-11-17");
  await expect(page.getByText("Public feed · Read only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Read Beyond the Black Patch/ }),
  ).toBeVisible();
  await capture("public-day");
  await page.goto("/public/today");
  await expect(page.getByText("Public feed · Read only")).toBeVisible();
  await page
    .getByRole("button", { name: /Read Beyond the Black Patch/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeVisible();
  await capture("public-feed");
});
