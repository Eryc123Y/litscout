import { expect, test, type Locator, type Page } from "@playwright/test";

test.skip(({ isMobile }) => !isMobile, "Phone layout");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});

async function fits(page: Page, name: string) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    localOverflow: Array.from(
      document.querySelectorAll(
        ".reading-pane, .library-results, [data-slot=dialog-content]",
      ),
    ).some((element) => element.scrollWidth > element.clientWidth),
  }));
  expect(widths.document, name).toBeLessThanOrEqual(widths.viewport);
  expect(widths.body, name).toBeLessThanOrEqual(widths.viewport);
  expect(widths.localOverflow, name).toBe(false);
}

async function touchTarget(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function shot(page: Page, name: string) {
  await fits(page, name);
  if (process.env.LITSCOUT_SCREENSHOTS === "1") {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: test.info().outputPath(`review-phone-${name}.png`),
      scale: "css",
      animations: "disabled",
    });
  }
}

test("phone navigation, More, theme and Library filters are usable", async ({
  page,
}) => {
  await page.goto("/app/today");
  const navigation = page.getByRole("navigation", { name: "Main" });
  await expect(navigation.getByRole("link")).toHaveText([
    "Today",
    "Days",
    "Library",
    "Ideas",
  ]);
  for (const tab of await navigation.getByRole("link").all())
    await touchTarget(tab);

  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await expect(page.getByRole("status", { name: "Page updates" })).toHaveCount(
    1,
  );
  const search = page.getByRole("button", { name: "Search papers" });
  await touchTarget(search);
  await search.tap();
  const searchDialog = page.getByRole("dialog", { name: "Search papers" });
  await touchTarget(searchDialog.getByRole("button", { name: "Close" }));
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  const paperFilters = page.getByRole("button", {
    name: "Filters",
    exact: true,
  });
  await touchTarget(paperFilters);
  await paperFilters.tap();
  const unread = page.getByRole("button", { name: "Unread" });
  await touchTarget(unread);
  await unread.tap();
  await expect(page).toHaveURL(/unread=true/);
  await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear all" }).tap();

  const theme = page.getByRole("button", { name: "Dark appearance" });
  await touchTarget(theme);
  await theme.tap();
  await expect(theme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "today-dark");

  const more = navigation.getByRole("button", { name: "More" });
  await touchTarget(more);
  await more.tap();
  const menu = page.getByRole("dialog", { name: "More" });
  await shot(page, "more");
  for (const link of await menu.getByRole("link").all())
    await touchTarget(link);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await more.tap();
  await menu.getByRole("link", { name: "Settings" }).tap();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  await navigation.getByRole("link", { name: "Library" }).tap();
  // Search stays on the page; the other filters open in a sheet.
  const librarySearch = page.getByRole("searchbox", {
    name: "Search title or author",
  });
  await touchTarget(librarySearch);
  await librarySearch.fill("Forcing");
  await librarySearch.press("Enter");
  await expect(page).toHaveURL(/\?q=Forcing$/);
  const filters = page.getByRole("button", { name: "Filters", exact: true });
  await touchTarget(filters);
  await filters.tap();
  const sheet = page.getByRole("dialog", { name: "Library filters" });
  await expect(sheet).toBeVisible();
  await shot(page, "library-filters");
  await touchTarget(sheet.getByRole("button", { name: "Apply filters" }));
  await sheet.getByLabel("Tags").fill("review");
  await sheet.getByRole("button", { name: "Apply filters" }).tap();
  await expect(page).toHaveURL(/q=Forcing&tags=review$/);
  await expect(sheet).toBeHidden();
  const activeFilters = page.getByRole("button", { name: "Filters (1)" });
  await expect(activeFilters).toBeFocused();
  await activeFilters.tap();
  await sheet.getByRole("button", { name: "Clear filters" }).tap();
  await expect(page).toHaveURL(/\?q=Forcing$/);
  await librarySearch.fill("");
  await librarySearch.press("Enter");
  await expect(page).toHaveURL(/\/app\/library$/);
  await expect(sheet).toBeHidden();
});

test("Today and dated listings return to the paper row after reading", async ({
  page,
}) => {
  for (const [name, path] of [
    ["today", "/app/today"],
    ["day", "/app/days/2026-11-17"],
  ] as const) {
    await page.goto(path);
    const brief = page.getByRole("region", { name: "Morning brief" });
    const toggle = brief.getByRole("button", { name: /Morning brief/ });
    const radar = brief.getByRole("region", { name: "Radar", exact: true });
    const paper = page.getByRole("button", {
      name: /Read Beyond the Black Patch/,
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(radar).toBeHidden();
    await touchTarget(toggle);
    await touchTarget(paper);
    await shot(page, name);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(radar).toBeVisible();
    if (name === "today") await shot(page, "today-brief");

    await paper.evaluate((row) => row.scrollIntoView({ block: "center" }));
    const listPosition = await page.evaluate(() => window.scrollY);
    expect(listPosition).toBeGreaterThan(0);
    await paper.tap();
    await expect(page).toHaveURL(/paper=pap_/);
    const deepLink = new URL(page.url());
    const reader = page.getByRole("region", { name: "Selected paper" });
    await expect(
      reader.getByRole("heading", { name: /Beyond the Black Patch/ }),
    ).toBeFocused();
    await expect(
      reader.getByRole("region", { name: "Five-part summary" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeHidden();
    expect(await reader.boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    });
    const back = reader.getByRole("button", { name: "Back to the list" });
    // Back, Previous and Next sit in a bar at the bottom of the screen.
    const next = reader.getByRole("button", { name: "Next paper" });
    await expect(next).toBeInViewport();
    await expect(page.getByText(/j \/ k to move/)).toBeHidden();
    for (const control of [
      back,
      next,
      reader.getByRole("button", { name: /Sav(e|ed) to library/ }),
      reader.getByRole("button", { name: "Rate up" }),
      reader.getByRole("button", { name: "Capture idea" }),
      reader.getByRole("button", { name: "Link to an idea" }),
      reader.getByRole("link", { name: "Open full record" }),
    ])
      await touchTarget(control);
    if (name === "today") await shot(page, "today-reading");
    await reader
      .getByRole("link", { name: "Open full record" })
      .scrollIntoViewIfNeeded();
    await expect(back).toBeInViewport();
    await back.tap();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(paper).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(listPosition);

    await paper.tap();
    await expect(reader).toBeVisible();
    await page.goBack();
    await expect(paper).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBe(listPosition);

    if (name === "today") {
      deepLink.searchParams.set("topic", "Vision");
      await page.goto(deepLink.href);
      await expect(
        reader.getByRole("heading", { name: /Beyond the Black Patch/ }),
      ).toBeVisible();
      await back.tap();
      await expect(page).toHaveURL(/\/app\/today\?topic=Vision$/);
      await expect(paper).toBeVisible();
    }
  }
});

test("each phone page fits the supported widths and provides a review shot", async ({
  page,
}) => {
  const main = page.getByRole("main");
  const paperRow = main.getByRole("button", {
    name: /Read Beyond the Black Patch/,
  });
  await page.goto("/app/today");
  await paperRow.tap();
  const paperPath = (await main
    .getByRole("link", { name: "Open full record" })
    .getAttribute("href"))!;
  const privateScreens: {
    name: string;
    path: string;
    ready: Locator;
    target?: Locator;
  }[] = [
    {
      name: "paper",
      path: paperPath,
      ready: main.getByRole("heading", { name: "Identifiers and links" }),
      target: main.getByRole("button", { name: "Capture idea" }),
    },
    {
      name: "days",
      path: "/app/days",
      ready: main.getByRole("region", { name: "Calendar" }),
      target: main.getByRole("button", { name: /^Tuesday, 17 November 2026:/ }),
    },
    {
      name: "library",
      path: "/app/library",
      ready: main.getByRole("link", {
        name: /Forcing a Letter Suppresses Refusal/,
      }),
      target: main.getByRole("button", { name: "Add paper", exact: true }),
    },
    {
      name: "projects",
      path: "/app/projects",
      ready: main.getByRole("link", { name: /^PRIVATE_Vision project/ }),
    },
    {
      name: "ideas",
      path: "/app/ideas",
      ready: main.getByRole("heading", { name: "PRIVATE_Depth idea" }),
      target: main.getByRole("button", {
        name: "Actions for PRIVATE_Depth idea",
      }),
    },
    {
      name: "working-papers",
      path: "/app/working-papers",
      ready: main.getByRole("link", {
        name: "PRIVATE_Depth draft",
        exact: true,
      }),
    },
    {
      name: "vault-sync",
      path: "/app/vault",
      ready: main.getByRole("region", { name: "Needs review" }),
    },
    {
      name: "health",
      path: "/app/health",
      ready: main.getByRole("heading", { name: "Digest delivery" }),
    },
    {
      name: "settings",
      path: "/app/settings",
      ready: main.getByRole("radiogroup", { name: "Appearance" }),
      target: main.getByRole("button", { name: "Download export bundle" }),
    },
  ];
  const verify = async (name: string, ready: Locator, target?: Locator) => {
    await expect(ready).toBeVisible();
    for (const width of [375, 430, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await fits(page, `${name} at ${width}px`);
      if (target) await touchTarget(target);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, name);
  };
  for (const { name, path, ready, target } of privateScreens) {
    await page.goto(path);
    await verify(name, ready, target);
    if (name === "working-papers") {
      await ready.tap();
      await verify(
        "working-paper",
        main.getByRole("heading", { name: "PRIVATE_Depth draft" }),
        main.getByRole("link", { name: "Write in Obsidian" }),
      );
    }
  }
  for (const [name, path] of [
    ["today", "/app/today"],
    ["day", "/app/days/2026-11-17"],
    ["public-feed", "/public/today"],
    ["public-day", "/public/days/2026-11-17"],
    ["public-days", "/public/days"],
    ["public-paper", paperPath.replace("/app/", "/public/")],
  ] as const) {
    await page.goto(path);
    if (name === "today" || name === "day") {
      // The reading flow above captures these pages in their initial state.
      await expect(paperRow).toBeVisible();
      for (const width of [375, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await fits(page, `${name} at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    } else {
      await verify(
        name,
        name === "public-days"
          ? main.getByRole("region", { name: "Calendar" })
          : name === "public-paper"
            ? main.getByRole("heading", { name: "Identifiers and links" })
            : paperRow,
      );
    }
  }
  await page.route("**/api/v1/instance", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.publicFeed = false;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await verify(
    "public-landing",
    main.getByRole("heading", { name: "Your research, one day at a time." }),
    main.getByRole("link", { name: "Sign in" }),
  );
});

test("phone trends artboard for review", async ({ page }) => {
  test.skip(process.env.LITSCOUT_SCREENSHOTS !== "1");
  await page.goto("/app/trends?month=2026-11&topic=Vision");
  await expect(
    page.getByRole("heading", { name: "Recurring terms" }),
  ).toBeVisible();
  await shot(page, "trends");
});
