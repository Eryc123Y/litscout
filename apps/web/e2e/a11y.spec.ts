import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./navigation";

// Every private and public page of the fixture server, at the project's size
// (desktop and phone), with the WCAG 2.1 A and AA rules the other specs use.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});

async function violations(page: Page) {
  await expect(page.getByRole("main")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const violations = await axeViolations(page);
  return violations.map(
    (v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(" ")}`,
  );
}

const routes = [
  "/app/today",
  "/app/days",
  "/app/days/2026-11-17",
  "/app/library",
  "/app/projects",
  "/app/ideas",
  "/app/working-papers",
  "/app/vault",
  "/app/health",
  "/app/settings",
  "/app/trends",
  "/public/today",
  "/public/days/2026-11-17",
];

for (const path of routes)
  test(`${path} passes axe`, async ({ page }) => {
    await page.goto(path);
    expect(await violations(page)).toEqual([]);
  });

test("a full paper page passes axe", async ({ page }) => {
  await page.goto("/app/days/2026-11-17");
  const row = page.getByRole("button", { name: /Read Beyond the Black Patch/ });
  await row.click();
  const full = page.getByRole("link", { name: /full (record|view)/i }).first();
  if (await full.isVisible()) await full.click();
  expect(await violations(page)).toEqual([]);
});

test("a working paper detail passes axe", async ({ page }) => {
  await page.goto("/app/working-papers");
  await page
    .getByRole("link", { name: "PRIVATE_Depth draft", exact: true })
    .click();
  expect(await violations(page)).toEqual([]);
});

// Contrast and focus styles under the dark palette, which the system setting picks.
for (const path of [
  "/app/today",
  "/app/days/2026-11-17",
  "/app/library",
  "/app/trends",
])
  test(`${path} passes axe in dark mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(path);
    expect(await violations(page)).toEqual([]);
  });
