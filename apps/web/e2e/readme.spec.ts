import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// The README's pictures, taken from the fixture reader so they never show a
// real library. Opt in with `tools/readme-images.sh`, which also turns the
// triage recording into a GIF. Not part of the test run.
const out = path.resolve("docs/images");
const day = "/app/days/2026-11-12";
const viewport = { width: 1200, height: 750 };

test.beforeEach(({}, testInfo) => {
  test.skip(
    process.env.LITSCOUT_README !== "1" || testInfo.project.name !== "desktop",
  );
});

// The fixture stamps its brief with the time it started. Show the demo
// day's morning instead, so the pictures do not change with every run.
async function steadyDates(context: BrowserContext) {
  const today = new Date().toISOString().slice(0, 10);
  const stamp = new RegExp(`"${today}T[0-9:.]+Z"`, "g");
  await context.route("**/api/v1/**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace(
      stamp,
      '"2026-11-12T02:40:00.000Z"',
    );
    await route.fulfill({ response, body });
  });
}
async function settle(page: Page) {
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1 }),
  ).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
}
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: path.join(out, `${name}.png`),
    scale: "device",
    animations: "disabled",
  });

test("pictures for the README", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(out, { recursive: true });
  const open = async (colorScheme: "light" | "dark", size = viewport) => {
    const context = await browser.newContext({
      baseURL,
      viewport: size,
      deviceScaleFactor: 2,
      colorScheme,
      reducedMotion: "reduce",
    });
    await steadyDates(context);
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-11-12T04:00:00Z") });
    return { context, page };
  };

  // The day page with its morning brief, in both themes.
  for (const scheme of ["light", "dark"] as const) {
    const { context, page } = await open(scheme);
    await page.goto(day);
    await expect(
      page.getByRole("region", { name: "Morning brief" }),
    ).toBeVisible();
    await settle(page);
    await shot(page, `day-${scheme}`);
    await context.close();
  }

  const { context, page } = await open("light");
  // A paper open beside the list.
  await page.goto(day);
  await page
    .getByRole("button", { name: /Read Sparse-View Depth from Handheld Video/ })
    .click();
  await expect(
    page.getByRole("toolbar", { name: "Reading actions" }),
  ).toBeVisible();
  await settle(page);
  await shot(page, "paper");

  await page.goto("/app/trends?month=2026-11&topic=Vision");
  await expect(
    page.getByRole("heading", { name: "Recurring terms" }),
  ).toBeVisible();
  await settle(page);
  await shot(page, "trends");
  await context.close();

  // The same day on a phone.
  const phone = await open("light", { width: 390, height: 780 });
  await phone.page.goto(day);
  await settle(phone.page);
  await shot(phone.page, "phone");
  await phone.context.close();
});

test("a triage recording for the README", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const size = { width: 1040, height: 650 };
  const context = await browser.newContext({
    baseURL,
    viewport: size,
    recordVideo: { dir: path.join(out, ".recording"), size },
    colorScheme: "light",
  });
  await steadyDates(context);
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-11-12T04:00:00Z") });
  const pause = (ms: number) => page.waitForTimeout(ms);
  await page.goto(day);
  await settle(page);
  await pause(1400);
  await page.getByRole("button", { name: "Start triage" }).click();
  // Off the list, so no row stays highlighted under the pointer.
  await page.mouse.move(4, 4);
  const bar = page.getByRole("toolbar", { name: "Triage decision" });
  await expect(bar).toBeVisible();
  await pause(1600);
  // To read, skip, save: one key each, and the next paper opens.
  for (const key of ["l", "x", "x", "s", "l", "x"]) {
    await page.keyboard.press(key);
    await pause(1300);
  }
  await page.keyboard.press("u");
  await pause(1500);
  await page.getByRole("link", { name: /Library · To read/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Library");
  await pause(2200);
  const video = page.video();
  await context.close();
  if (video) renameSync(await video.path(), path.join(out, ".recording.webm"));
});
