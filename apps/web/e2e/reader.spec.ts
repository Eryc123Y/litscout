import { test, expect } from "@playwright/test";
import { openMoreOnPhone } from "./navigation";
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
});
test("Today filters by topic and opens a paper", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("/app/today");
  await expect(page).toHaveTitle("Today · LitScout");
  if (testInfo.project.name === "phone")
    await page.getByRole("button", { name: "Morning brief Expand" }).click();
  else
    await expect(
      page.getByRole("heading", { name: "Morning brief", exact: true }),
    ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Radar", exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /^Vision \d+$/ }).click();
  const row = page.getByRole("button", { name: /Read Beyond the Black Patch/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeInViewport();
  await expect(
    page.getByRole("term").filter({ hasText: /^Method$/ }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("reading.png"),
    fullPage: true,
    scale: "css",
  });
  await expect(page).toHaveURL(/paper=pap_/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open full record" }).click();
  await expect(page).toHaveURL(/\/app\/papers\/pap_/);
  await expect(
    page.getByRole("heading", { name: "Abstract", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("legacy deep link redirects with selected topic and identifier", async ({
  page,
}) => {
  await page.goto(
    "/#day=2026-11-17&topic=Vision&paper=doi%3A10.1109%2Ftvcg.2026.3747406",
  );
  await expect(page).toHaveURL(
    /\/public\/days\/2026-11-17\?topic=Vision&paper=/,
  );
  await expect(
    page.getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeVisible();
});
test("public feed never fetches or renders private fields", async ({
  page,
  request,
}) => {
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  for (const path of [
    "/api/v1/public/days",
    "/api/v1/public/days/2026-11-17",
  ]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toMatch(
      /PRIVATE_|"(?:bodyMd|radar|profile|rating|notes|library|ideas|userId|client|model)":/,
    );
  }
  await page.goto("/public/today");
  await expect(page.getByText("Public feed · Read only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Read Beyond the Black Patch/ }),
  ).toBeVisible();
  expect(await page.content()).not.toContain("PRIVATE_");
  expect(paths.some((p) => p.includes("digests"))).toBe(false);
  expect(
    paths
      .filter((p) => p.startsWith("/api/v1/"))
      .every(
        (p) => p === "/api/v1/instance" || p.startsWith("/api/v1/public/"),
      ),
  ).toBe(true);
});
test("theme persists and the command dialog traps and restores focus", async ({
  page,
}, testInfo) => {
  await page.goto("/app/today");
  // The light and dark pair sits in the top bar (phone: the phone header).
  const dark = page.getByRole("button", { name: "Dark appearance" });
  await dark.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: /^Today(?: \d+)?$/ }).click();
  const trigger = page.getByRole("button", {
    name: "Search papers",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Search papers" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Search titles and authors" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("dark.png"),
    fullPage: true,
    scale: "css",
  });
});
test("Days calendar distinguishes pending and no announcement", async ({
  page,
}) => {
  await page.goto("/app/days");
  await expect(
    page.getByRole("heading", { name: "Days", exact: true }),
  ).toBeVisible();
  const calendar = page.getByRole("region", { name: "Calendar", exact: true });
  const paperList = page.getByRole("region", {
    name: "Paper list",
    exact: true,
  });
  const updates = page.getByRole("status", { name: "Page updates" });
  await calendar
    .getByRole("button", {
      name: "Monday, 16 November 2026: No announcement",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/app\/days\/2026-11-16$/);
  await expect(
    paperList.getByText("No announcement for this day."),
  ).toBeVisible();
  await expect(updates).toContainText("No announcement");
  await page.getByRole("link", { name: "Choose a day" }).click();
  await calendar
    .getByRole("button", {
      name: "Wednesday, 18 November 2026: Pending announcement",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(/\/app\/days\/2026-11-18$/);
  await expect(
    paperList.getByText("Waiting for an announcement."),
  ).toBeVisible();
  await expect(updates).toContainText("Pending announcement");
});
test("CSP blocks no app work and shipped HTML has no inline code", async ({
  page,
  request,
}) => {
  const response = await request.get("/app/today");
  const html = await response.text();
  expect(response.headers()["content-security-policy"]).toContain(
    "script-src 'self'",
  );
  expect(response.headers()["content-security-policy"]).toContain(
    "style-src 'self'",
  );
  expect(html).not.toMatch(
    /<style\b|\sstyle=|\son\w+=|<script(?![^>]*\bsrc=)/i,
  );
  const violations: string[] = [];
  await page.exposeFunction("reportCsp", (s: string) => violations.push(s));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { reportCsp: (s: string) => void }).reportCsp(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
      ),
    ),
  );
  await page.goto("/app/today");
  await expect(page.getByRole("radio", { name: /^Vision \d+$/ })).toBeVisible();
  await page
    .getByRole("button", { name: "Search papers", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search papers" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openMoreOnPhone(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark" }).check();
  await page.getByRole("link", { name: "Days", exact: true }).click();
  await expect(page.getByRole("region", { name: "Calendar" })).toBeVisible();
  expect(violations).toEqual([]);
});
test("text and topic colours have readable contrast in both themes", async ({
  page,
}) => {
  await page.goto("/app/today");
  await openMoreOnPhone(page);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  for (const [mode, palette] of [
    ["Light", "journal"],
    ["Dark", "graphite"],
  ]) {
    await page.getByRole("radio", { name: mode! }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", palette!);
    const ratios = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement),
        ctx = document.createElement("canvas").getContext("2d")!;
      const luminance = (colour: string) => {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        const data = ctx.getImageData(0, 0, 1, 1).data;
        const rgb = [data[0]!, data[1]!, data[2]!].map((x) => {
          const c = x / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const values = [
        "--ink",
        "--subtle",
        "--muted",
        "--accent",
        "--radar",
        "--error",
      ].map((name) => ({
        name,
        colour: style.getPropertyValue(name),
      }));
      document
        .querySelectorAll('[data-slot="badge"][data-variant="topic"]')
        .forEach((badge, index) =>
          values.push({
            name: "topic " + index,
            colour: getComputedStyle(badge).color,
          }),
        );
      const contrast = (foreground: string, background: string) => {
        const a = luminance(foreground),
          b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const result = [
        "--surface",
        "--ground",
        "--soft",
        "--radar-soft",
      ].flatMap((surface) =>
        values.map(({ name, colour }) => ({
          name,
          colour,
          surface,
          ratio: contrast(colour, style.getPropertyValue(surface)),
        })),
      );
      result.push({
        name: "filled action",
        colour: style.getPropertyValue("--accent-ink"),
        surface: "--accent",
        ratio: contrast(
          style.getPropertyValue("--accent-ink"),
          style.getPropertyValue("--accent"),
        ),
      });
      result.push({
        name: "brand mark",
        colour: style.getPropertyValue("--surface"),
        surface: "--ink",
        ratio: contrast(
          style.getPropertyValue("--surface"),
          style.getPropertyValue("--ink"),
        ),
      });
      result.push({
        name: "destructive action",
        colour: style.getPropertyValue("--error-ink"),
        surface: "--error",
        ratio: contrast(
          style.getPropertyValue("--error-ink"),
          style.getPropertyValue("--error"),
        ),
      });
      return result;
    });
    for (const ratio of ratios)
      expect(
        ratio.ratio,
        `${palette} text contrast: ${JSON.stringify(ratio)}`,
      ).toBeGreaterThanOrEqual(4.5);
  }
});

test("the shell and calendar fit narrow windows", async ({ page }) => {
  for (const width of [360, 800, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/app/today",
      "/app/days",
      "/public/today",
      "/public/days",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: path.endsWith("days") ? "Days" : /Tuesday/,
        }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${path} at ${width}px`,
      ).toBe(true);
      if (width >= 768 && width <= 1024) {
        const sidebar = await page
          .getByRole("complementary", { name: "Sidebar" })
          .boundingBox();
        expect(sidebar!.width).toBeLessThan(100);
      }
    }
  }
});

test("Library confirms a match and opens its private paper record", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get("/api/v1/feed/days/2026-11-17");
  const { data } = (await response.json()) as {
    data: { items: { paperId: string; title: string }[] };
  };
  const paper = data.items.find((item) =>
    item.title.includes("Beyond the Black Patch"),
  )!;
  // Both projects use the same D1 fixture. Start with an explicit rating so
  // the assertion exercises the same toggle transition on either project.
  await expect(
    await request.post("/api/v1/events", {
      data: { paperId: paper.paperId, kind: "rate_down" },
    }),
  ).toBeOK();
  // Replay metadata lookup in CI. The confirmed paper and subsequent changes
  // use the local Worker and D1.
  await page.route("**/api/v1/library/save", async (route) => {
    const body = route.request().postDataJSON() as { dry_run: boolean };
    if (!body.dry_run) return route.continue();
    await route.fulfill({
      json: {
        success: true,
        data: {
          status: "confirm",
          candidates: [
            {
              query: paper.paperId,
              title: paper.title,
              authors: [],
              source: "crossref",
              link: null,
            },
          ],
        },
      },
    });
  });
  await page.goto("/app/today");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Add paper" }).click();
  const add = page.getByRole("dialog", { name: "Add a paper" });
  await add
    .getByLabel("DOI, URL, arXiv ID or title")
    .fill("Beyond the Black Patch");
  await add.getByRole("button", { name: "Find" }).click();
  await add.getByRole("button", { name: "Not this one" }).click();
  await expect(add.getByRole("button", { name: "Add to library" })).toHaveCount(
    0,
  );
  await add.getByRole("button", { name: "Find" }).click();
  await add.getByRole("button", { name: "Add to library" }).click();
  await expect(add).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Publisher page" }),
  ).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Search title or author",
  });
  await search.fill("Beyond the Black Patch");
  await search.press("Enter");
  const title = page.getByRole("link", { name: paper.title, exact: true });
  await expect(title).toBeVisible();
  await title.click();
  await expect(
    page.getByRole("heading", { name: paper.title, exact: true }),
  ).toBeVisible();
  const actions = page.getByRole("toolbar", { name: "Reading actions" });
  const saved = actions.getByRole("button", { name: "Save to library" });
  await expect(saved).toHaveAttribute("aria-pressed", "true");
  await expect(saved).toBeDisabled();
  const rating = actions.getByRole("button", { name: "Rate down" });
  await expect(rating).toHaveAttribute("aria-pressed", "true");
  await rating.click();
  await expect(rating).toHaveAttribute("aria-pressed", "false");
  await rating.click();
  await expect(rating).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(rating).toHaveAttribute("aria-pressed", "true");

  const notes = page.getByRole("region", { name: "Quick notes" });
  const note = "A library note (" + testInfo.project.name + ")";
  await expect(notes.getByText(note, { exact: true })).toHaveCount(0);
  await notes.getByRole("button", { name: "Add note" }).click();
  await notes.getByLabel("Note (Markdown)").fill(`**${note}**`);
  await notes.getByRole("button", { name: "Save note" }).click();
  await expect(notes.getByText(note, { exact: true })).toBeVisible();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  test(`a day reads in two columns that scroll on their own at ${viewport.width}×${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await page.setViewportSize(viewport);
    await page.clock.setSystemTime(new Date("2026-11-10T04:00:00Z"));
    await page.goto("/app/today");
    await page.evaluate(() => document.fonts.ready);
    // No rail: the brief is the reader's first page, always open.
    await expect(
      page.getByRole("complementary", { name: "This day" }),
    ).toHaveCount(0);
    const reader = page.getByRole("region", { name: "Reader" });
    const brief = reader.getByRole("region", { name: "Morning brief" });
    await expect(
      brief.getByRole("region", { name: "Radar", exact: true }),
    ).toBeVisible();
    await expect(
      brief.getByRole("button", { name: /Collapse|Expand/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("radiogroup", { name: "Topics" })).toHaveCount(
      1,
    );

    // Scroll the list, open a paper further down: the row, the list and the
    // page all stay where they were.
    const list = page.getByRole("region", { name: "Paper list" });
    const rows = list.getByRole("button");
    const row = rows.nth(5);
    await row.scrollIntoViewIfNeeded();
    const before = (await row.boundingBox())!;
    await row.click();
    const selected = page.getByRole("region", { name: "Selected paper" });
    await expect(
      selected.getByRole("heading", { level: 2 }).first(),
    ).toBeFocused();
    const after = (await row.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(row).toHaveAttribute("aria-current", "true");
    // The page itself never grows past the window: only the columns scroll.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= window.innerHeight,
      ),
    ).toBe(true);

    // j moves to the next paper and keeps its row in view.
    await page.keyboard.press("j");
    await expect(rows.nth(6)).toHaveAttribute("aria-current", "true");
    await expect(rows.nth(6)).toBeInViewport();
    // The paper just left is read, so its whole row fades; the open row and
    // an unread one keep full ink.
    await page.mouse.move(0, 0);
    const ink = (index: number) =>
      rows
        .nth(index)
        .locator("strong")
        .evaluate((title) => getComputedStyle(title).opacity);
    await expect.poll(() => ink(5)).toBe("0.45");
    expect(await ink(6)).toBe("1");
    expect(await ink(0)).toBe("1");
    // The keys work from the list as well as the reader.
    await rows.nth(2).focus();
    await page.keyboard.press("k");
    await expect(rows.nth(5)).toHaveAttribute("aria-current", "true");

    // Escape (or Back to brief) brings the brief back.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Reader" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Morning brief/ }),
    ).toHaveAttribute("aria-current", "true");

    // The divider resizes the list and the width is kept for next time.
    const handle = page.getByRole("separator", {
      name: "Resize the paper list",
    });
    const width = async () =>
      (await page.locator(".reader-list-pane").boundingBox())!.width;
    const start = await width();
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(width).toBeGreaterThan(start + 20);
    const resized = await width();
    await page.reload();
    await expect.poll(width).toBeCloseTo(resized, 0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test("Today keeps a long brief initially collapsed on the phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone");
  await page.clock.setSystemTime(new Date("2026-11-10T04:00:00Z"));
  await page.goto("/app/today");

  const brief = page.getByRole("region", { name: "Morning brief" });
  const radar = brief.getByRole("region", { name: "Radar", exact: true });
  const toggle = brief.getByRole("button", { name: "Morning brief Expand" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(radar).toBeHidden();
  await toggle.tap();
  await expect(radar.getByRole("link")).toHaveCount(3);
  await expect(
    radar.getByText(/reported setup overlaps/).first(),
  ).toBeVisible();
  await radar.getByRole("button", { name: "Show more radar hits" }).tap();
  await expect(radar.getByRole("link")).toHaveCount(5);
  const suggestions = brief.getByRole("region", { name: "Idea suggestions" });
  await expect(
    suggestions.getByRole("button", { name: "Add to Inbox" }),
  ).toHaveCount(3);
  await expect(
    suggestions.getByText(/Start by recording the camera motion/).first(),
  ).toBeVisible();
});

test("lists only papers on the reader's topics; a search still finds the others", async ({
  page,
}) => {
  const outside = "Outside Every Topic: A Fixture Paper";
  await page.goto("/app/days/2026-11-17");
  const papers = page.getByRole("region", { name: "Papers" });
  await expect(papers.getByText(/Beyond the Black Patch/)).toBeVisible();
  await expect(papers.getByText(outside)).toHaveCount(0);
  await expect(
    // One count everywhere: the papers on your topics, as the list shows.
    page.getByText(/3 papers on your topics/).first(),
  ).toBeVisible();
  await page.goto("/app/days/2026-11-17?q=Outside%20Every");
  await expect(papers.getByText(outside)).toBeVisible();
});

test("a paper still loading is drawn in place, and nothing above the summary moves when its record arrives", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/app/days/2026-11-10");
  const rows = page
    .getByRole("region", { name: "Paper list" })
    .getByRole("button");
  await expect(rows.nth(9)).toBeVisible();
  // Hold every paper record back, as a slow network would.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/papers/**", async (route) => {
    await held;
    await route.fallback();
  });
  await rows.nth(9).click();
  const pane = page.getByRole("region", { name: "Selected paper" });
  const title = pane.getByRole("heading", { level: 2 }).first();
  const loading = pane.getByText("Loading the full record…");
  await expect(loading).toBeVisible();
  // Already the full view: the way back, the real actions, the title.
  const back = pane.getByRole("button", { name: "Back to brief" });
  const actions = pane.getByRole("toolbar", { name: "Reading actions" });
  await expect(back).toBeVisible();
  await expect(actions).toBeVisible();
  // The loader itself waits 200 ms, so a fast answer never flashes one.
  expect(
    await page
      .locator(".loading-state")
      .first()
      .evaluate((el) => getComputedStyle(el).animationDelay),
  ).toBe("0.2s");
  const before = {
    back: await back.boundingBox(),
    title: await title.boundingBox(),
    actions: await actions.boundingBox(),
  };
  release();
  await expect(loading).toHaveCount(0);
  await expect(
    pane.getByRole("heading", { name: "Quick notes" }),
  ).toBeVisible();
  expect({
    back: await back.boundingBox(),
    title: await title.boundingBox(),
    actions: await actions.boundingBox(),
  }).toEqual(before);
});

test("a neighbouring day is fetched when its link is hovered, and then opens with no second request", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/app/days/2026-11-17");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/feed\/days\/2026-11-16\?/.test(request.url()))
      requests.push(request.url());
  });
  const previous = page.getByRole("link", { name: "Previous day" });
  await previous.hover();
  await expect.poll(() => requests.length).toBe(1);
  await previous.click();
  await expect(page).toHaveURL(/\/days\/2026-11-16/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "16 November",
  );
  // The page read the list the hover fetched: the same cache entry.
  expect(requests).toHaveLength(1);
});

test("searches every day from a page that is not a day, and opens the paper on its day", async ({
  page,
}) => {
  await page.goto("/app/library");
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Search papers" });
  await dialog
    .getByRole("combobox", { name: "Search titles and summaries" })
    .fill("black patch");
  const hit = dialog.getByRole("option", { name: /Beyond the Black Patch/ });
  await expect(hit).toContainText("17 Nov 2026");
  await hit.click();
  await expect(page).toHaveURL(/\/app\/days\/2026-11-17\?paper=pap_/);
  await expect(
    page
      .getByRole("region", { name: "Selected paper" })
      .getByRole("heading", { name: /Beyond the Black Patch/ }),
  ).toBeVisible();
});

test("Days marks listed dates and says what is left to read", async ({
  page,
}) => {
  await page.goto("/app/days");
  const calendar = page.getByRole("region", { name: "Calendar" });
  await expect(
    calendar.getByRole("list", { name: "Calendar marks" }),
  ).toBeVisible();
  // 17 November has a listing in the fixtures: its cell carries a mark.
  const cell = calendar
    .getByRole("button", { name: /^Tuesday, 17 November 2026:/ })
    .locator("xpath=..");
  await expect(cell).toHaveClass(/day-(digest|listing)/);
  const row = page
    .getByRole("link", { name: "17 Nov 2026" })
    .locator("xpath=ancestor::li[1]");
  await expect(row).toContainText(/on your topics · (\d+ unread|all read)/);
  await expect(row.getByRole("progressbar")).toBeVisible();
});

test("reads an arXiv PDF beside the summary on a wide screen", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "Phones open PDFs in a new tab");
  await page.setViewportSize({ width: 1920, height: 1080 });
  const frameWidth = async () =>
    (await page
      .locator('header[aria-label="Top bar"] > div')
      .first()
      .boundingBox())!.width;
  // A stand-in for arxiv.org: the frame loads only if the CSP allows it.
  await page.route("https://arxiv.org/pdf/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>PDF stand-in</p>" }),
  );
  await page.goto("/app/days/2026-11-17");
  // The fixture's row order can differ between runs: note which way a
  // neighbour lies before the list steps aside. Only this paper has an
  // arXiv PDF, so any neighbour reads without one.
  const listRows = page
    .getByRole("region", { name: "Paper list" })
    .getByRole("button");
  await expect(listRows.filter({ hasText: "Forcing a Letter" })).toBeVisible();
  const rowNames = await listRows.allInnerTexts();
  const forcingRow = rowNames.findIndex((name) =>
    name.includes("Forcing a Letter"),
  );
  const toNoPdf = forcingRow < rowNames.length - 1 ? "j" : "k";
  await page.getByRole("button", { name: /Read Forcing a Letter/ }).click();
  const reader = page.getByRole("article", { name: /^Forcing a Letter/ });
  const readPdf = reader.getByRole("link", { name: "Read PDF" });
  await readPdf.click();
  const panel = page.getByRole("region", { name: "PDF" });
  await expect(panel.locator("iframe")).toHaveAttribute(
    "src",
    /^https:\/\/arxiv\.org\/pdf\//,
  );
  await expect(
    page.frameLocator('iframe[title^="PDF:"]').getByText("PDF stand-in"),
  ).toBeVisible();
  // With the PDF open the page drops its 88rem (1408 px) cap, top bar and
  // page together, so the PDF gets the width.
  expect(await frameWidth()).toBeGreaterThan(1500);
  // The list steps aside; the summary starts where the top bar's frame does.
  await expect(page.getByRole("region", { name: "Papers" })).toBeHidden();
  const papersBox = (await page
    .getByRole("region", { name: "Selected paper" })
    .boundingBox())!;
  const frameBox = (await page
    .locator('header[aria-label="Top bar"] > div')
    .first()
    .boundingBox())!;
  expect(Math.abs(frameBox.x - papersBox.x)).toBeLessThanOrEqual(1);
  // Escape puts the PDF away first; the reader stays open.
  await readPdf.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(reader).toBeVisible();
  expect(await frameWidth()).toBeLessThanOrEqual(1408);
  // o brings it back; Close returns focus to Read PDF.
  await page.keyboard.press("o");
  await panel.getByRole("button", { name: "Close PDF" }).click();
  await expect(panel).toHaveCount(0);
  await expect(readPdf).toBeFocused();
  // PDF mode is remembered: a paper without an arXiv PDF reads in the two
  // columns, and the next one with a PDF opens it again.
  await page.keyboard.press("o");
  await expect(panel).toBeVisible();
  await page.keyboard.press(toNoPdf);
  await expect(reader).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open full record" }),
  ).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Papers" })).toBeVisible();
  await page.keyboard.press(toNoPdf === "j" ? "k" : "j");
  await expect(reader).toBeVisible();
  await expect(panel).toBeVisible();
});
