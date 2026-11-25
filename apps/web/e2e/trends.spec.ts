import { expect, test } from "@playwright/test";

test("reads private trends and follows an abstract term to its papers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/app/today");
  if (testInfo.project.name === "phone")
    await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("link", { name: "Trends", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/trends/);
  await expect(
    page.getByRole("heading", { name: "Trends", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Topic", exact: true })
    .selectOption("Language");
  const term = page.getByRole("link", { name: /benchmarks/i }).first();
  await expect(term).toBeVisible();
  // Charts first; the exact numbers open as a table.
  await expect(
    page.getByRole("button", { name: /: [\d,]+ papers?$/ }).first(),
  ).toBeVisible();
  // A chart column selects its month; Next month brings the current one back.
  await page
    .getByRole("button", { name: /^Oct 2026: / })
    .first()
    .click();
  await expect(page.getByLabel("Month", { exact: true })).toHaveValue(
    "2026-10",
  );
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByLabel("Month", { exact: true })).toHaveValue(
    "2026-11",
  );
  await page.getByText("Show as table", { exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Monthly totals" })
      .getByRole("columnheader"),
  ).toHaveCount(13);
  await term.click();
  await expect(page).toHaveURL(/\/app\/days\?/);
  await expect(
    page.getByRole("heading", { name: /Papers matching “benchmarks”/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Forcing a Letter Suppresses Refusal/ }),
  ).toBeVisible();
  await page.goBack();
  await page.getByLabel("Month", { exact: true }).fill("2020-01");
  await expect(
    page.getByText(/first refresh after a daily digest/),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
