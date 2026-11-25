import { test, expect } from "@playwright/test";

// Restrained motion (2026-11-20): pages, the reading pane and
// popovers enter with a short fade; movement only without reduced motion.
const animationOf =
  (selector: string) => (page: import("@playwright/test").Page) =>
    page
      .locator(selector)
      .first()
      .evaluate((element) => getComputedStyle(element).animationName);

test("pages and the reading pane animate in, and stay still under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/app/days/2026-11-17");
  await expect(page.getByRole("region", { name: "Papers" })).toBeVisible();
  expect(await animationOf(".page-enter")(page)).toBe("page-in");
  expect(await animationOf("main.reader-page")(page)).toBe("none");
  await page.getByRole("button", { name: /Read Forcing a Letter/ }).click();
  await expect(page.locator(".reading-pane")).toBeVisible();
  expect(await animationOf(".reading-pane")(page)).toBe("pane-in");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app/days/2026-11-17");
  await expect(page.getByRole("region", { name: "Papers" })).toBeVisible();
  expect(await animationOf(".page-enter")(page)).toBe("none");
});

test("the page entrance plays once per visit, not again when the page's data arrives", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/app/library");
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeVisible();
  await page.evaluate(() => {
    const counter = window as unknown as { entrances: number };
    counter.entrances = 0;
    document.addEventListener("animationstart", (event) => {
      if (event.animationName === "page-in") counter.entrances += 1;
    });
  });
  // A slow answer: the day shows its loading page first, then the page.
  // Nothing fetches a day's list ahead of the visit, so this always happens.
  await page.route(/\/api\/v1\/feed\/days\/[\d-]+\?/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fallback();
  });
  await page
    .getByRole("link", { name: /^Today/ })
    .first()
    .click();
  await expect(page.locator('main[aria-busy="true"]')).toBeVisible();
  await expect(page.locator('main[aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { entrances: number }).entrances,
    ),
  ).toBe(1);
});

test("popovers fade in from their trigger", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/app/days/2026-11-17");
  // Closed popovers have no role yet; the transition is set on them anyway.
  const filters = page.locator(".filters-popover");
  const transition = await filters.evaluate(
    (element) => getComputedStyle(element).transitionProperty,
  );
  expect(transition).toContain("opacity");
});
