import {
  expect,
  test as base,
  type Locator,
  type Page,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openMoreOnPhone } from "./navigation";
import { runCommand } from "litscout/setup-commands";
import { configSchema } from "@litscout/core/config";

const origin = "http://127.0.0.1:4173";

const day = "2026-11-17";
const blackPatch = /Beyond the Black Patch/;
const refusal = /Forcing a Letter Suppresses Refusal/;
const idea = "PRIVATE_Depth idea";
const draft = "PRIVATE_Depth draft";

const test = base.extend<{
  shot: (name?: string) => Promise<void>;
  browserErrors: void;
}>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
  shot: async ({ page }, use, info) => {
    const directory = join(
      ".artifacts",
      "m4e",
      process.env.LITSCOUT_REVIEW_PHASE === "before" ? "before" : "after",
      info.project.name,
    );
    mkdirSync(directory, { recursive: true });
    await use(async (name = info.title) => {
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(directory, name + ".png"),
        animations: "disabled",
        scale: "css",
      });
      expect
        .soft(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBe(info.project.name === "phone" ? 390 : 1440);
    });
  },
});

test.skip(process.env.LITSCOUT_REVIEW_WALKTHROUGH !== "1", "Local review pack");
test.use({ actionTimeout: 5000, navigationTimeout: 10000 });

test.beforeEach(async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await page.setViewportSize(
    phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  );
  await page.clock.setFixedTime(new Date("2026-11-17T04:00:00Z"));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
});

test.afterEach(async ({ shot }, info) => {
  if (info.status === "failed") await shot(info.title + "-failure");
});

async function localCli(args: string[], directory: string) {
  let output = "";
  const unavailable = () =>
    Promise.reject(new Error("Unavailable in local review"));
  const code = await runCommand([...args, "--json"], {
    dir: directory,
    cwd: directory,
    templateDir: directory,
    bundlePath: "",
    loadConfig: async () =>
      configSchema.parse({
        instance: { publicUrl: origin },
        topics: [
          { name: "Vision", keywords: ["vision"] },
          { name: "Language", keywords: ["language"] },
        ],
        vault: {
          root: directory,
          projects: ["PRIVATE_Vault/Project.md"],
          digestsDir: "digests-new",
        },
      }),
    flow: { token: "local-review", now: () => new Date(day + "T04:00:00Z") },
    fetchVenues: unavailable,
    prompt: unavailable,
    run: unavailable,
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== origin)
        throw new Error("Only the local Worker is allowed");
      request.headers.delete("authorization"); // Use fixture-only LOCAL_DEV auth.
      return fetch(request, { redirect: "error" });
    },
    print: (line) => {
      output += line;
    },
  });
  expect(code, output).toBe(0);
  return JSON.parse(output).data;
}

async function expandBrief(page: Page) {
  const brief = page.getByRole("region", { name: "Morning brief" });
  if (page.viewportSize()!.width < 768)
    await brief.getByRole("button", { name: /Morning brief Expand/ }).click();
  return brief;
}

async function openPaper(page: Page, full = false) {
  await page
    .getByRole("button", { name: /Read Beyond the Black Patch/ })
    .click();
  const reader = page.getByRole("region", { name: "Selected paper" });
  await expect(
    reader.getByRole("region", { name: "Five-part summary" }),
  ).toBeVisible();
  if (full)
    await reader.getByRole("link", { name: "Open full record" }).click();
  return reader;
}

async function tabTo(page: Page, target: Locator) {
  for (let remaining = 70; remaining > 0; remaining--) {
    if (await target.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function removeSavedPaper(page: Page, title: string | RegExp) {
  const entry = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: title }) });
  await entry.getByRole("button", { name: /^Actions for / }).click();
  await entry.getByRole("button", { name: "Remove from library…" }).click();
  await entry.getByRole("button", { name: "Confirm remove" }).click();
  await expect(entry).toHaveCount(0);
}

async function cancelRequest(page: Page, name: string | RegExp) {
  await page.goto("/app/vault");
  const cancel = page
    .getByRole("region", { name: "Waiting for sync" })
    .getByRole("button", { name });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
}

test("today", async ({ page, shot }, info) => {
  await page.goto("/app/today");
  const brief = await expandBrief(page);
  const radar = brief.getByRole("region", { name: "Radar", exact: true });
  await expect(radar.getByText(/compare this recorded paper/)).toBeVisible();
  await expect(brief.getByRole("link", { name: refusal })).toBeVisible();
  await expect(
    page.getByRole("main").getByText("3 papers · 3 summaries · Final digest"),
  ).toBeVisible();
  if (info.project.name === "desktop") {
    const box = await page
      .getByRole("region", { name: "Paper list" })
      .boundingBox();
    expect(box!.y).toBeLessThan(900);
  }
  await shot();
  await page.getByRole("radio", { name: /^Vision \d+$/ }).click();
  await expect(page).toHaveURL(/topic=Vision/);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Source", { exact: true }).selectOption("journal");
  await expect(page).toHaveURL(/source=journal/);
  await expect(
    page.getByRole("button", { name: /Read Forcing a Letter/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Search papers" }).click();
  await page
    .getByRole("combobox", { name: "Search titles and authors" })
    .fill("Black Patch");
  await page.getByRole("option", { name: blackPatch }).click();
  await expect(page).toHaveURL(/paper=pap_/);
  await expect(
    page.getByRole("region", { name: "Five-part summary" }),
  ).toBeVisible();
});

test("days", async ({ page, shot }, info) => {
  await page.goto("/app/days");
  const calendar = page.getByRole("region", { name: "Calendar" });
  await calendar
    .getByRole("button", { name: new RegExp("^" + day + ":") })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tuesday 17 November" }),
  ).toBeVisible();
  await expect(
    (await expandBrief(page)).getByRole("region", {
      name: "Radar",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Read Beyond the Black Patch/ }),
  ).toBeVisible();
  await shot();
  if (info.project.name === "phone") {
    await page.getByRole("radio", { name: /^Vision \d+$/ }).tap();
    await expect(page).toHaveURL(/\/2026-11-17\?topic=Vision/);
  }
  await page.getByRole("link", { name: "Choose a day" }).click();
  await calendar
    .getByRole("button", { name: "Monday, 16 November 2026: No announcement" })
    .click();
  await expect(page.getByText("No announcement for this day.")).toBeVisible();
  await expect
    .soft((await expandBrief(page)).getByText("No digest for this day"))
    .toBeVisible();
  await shot("days-gap");
  await page.getByRole("link", { name: "Choose a day" }).click();
  await calendar
    .getByRole("button", {
      name: "Wednesday, 18 November 2026: Pending announcement",
    })
    .click();
  await expect(page.getByText("Waiting for an announcement.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Wednesday 18 November" }),
  ).toBeVisible();
  if (info.project.name === "desktop") {
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await expect(sidebar.getByTitle("Pending announcement")).toBeVisible();
    const shortcut = sidebar.getByRole("link", {
      name: "Vision 0",
      exact: true,
    });
    await expect(shortcut).toBeVisible();
    await shortcut.click();
    await expect.soft(page).toHaveURL(/\/2026-11-18\?topic=Vision/);
    await expect
      .soft(page.getByRole("link", { name: "Days", exact: true }))
      .toHaveAttribute("aria-current", "page");
  }
  await shot("days-pending");
});

test("trends", async ({ page, shot }, info) => {
  await page.goto("/app/today");
  await openMoreOnPhone(page);
  await page.getByRole("link", { name: "Trends", exact: true }).click();
  await page.getByLabel("Topic", { exact: true }).selectOption("Vision");
  await page.getByLabel("Month", { exact: true }).fill("2026-10");
  const selected = page.getByRole("region", { name: "Selected month" });
  await expect(
    selected.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  const overview = page.getByRole("region", { name: "Overview" });
  await expect(overview.getByRole("region", { name: "Papers" })).toContainText(
    "210",
  );
  await expect(
    overview.getByRole("region", { name: "Shortlisted" }),
  ).toContainText("36");
  await expect(
    overview.getByRole("region", { name: "Saved and rated" }),
  ).toContainText("1 saved");
  await expect(
    selected.getByRole("list", { name: "Radar grades" }).getByRole("listitem"),
  ).toHaveText(["1 high", "1 medium", "6 borrow"]);
  for (const name of [
    "Recurring terms",
    "Rising terms",
    "Digest picks",
    "Saved and rated papers",
  ])
    await expect(selected.getByRole("heading", { name })).toBeVisible();
  // Charts first; the exact numbers open as a table.
  await expect(
    page.getByRole("button", { name: /: [\d,]+ papers?$/ }).first(),
  ).toBeVisible();
  await page.getByText("Show as table", { exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Monthly totals" })
      .getByRole("columnheader"),
  ).toHaveCount(13);
  await shot();
  await page.getByLabel("Month", { exact: true }).fill("2026-11");
  await page.getByLabel("Topic", { exact: true }).selectOption("Language");
  const trends = await localCli(
    ["trends", "--topic", "Language", "--month", "2026-11"],
    info.outputDir,
  );
  expect(trends).toMatchObject({
    topic: "Language",
    month: "2026-11",
    detail: { volume: 120, recurring: [{ term: "benchmarks" }] },
  });
  await expect(selected).toContainText(trends.detail.volume + " papers");
  await selected.getByRole("link", { name: /benchmarks/i }).click();
  await expect(page).toHaveURL(/\/app\/days\?/);
  await expect(
    page.getByRole("heading", { name: /Papers matching “benchmarks”/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: refusal })).toBeVisible();
});

test("phone-reader", async ({ page, shot }, info) => {
  test.skip(info.project.name !== "phone", "Phone-only review-pack row");
  await page.goto("/app/today");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText([
    "Today",
    "Days",
    "Library",
    "Ideas",
  ]);
  await nav.getByRole("button", { name: "More" }).tap();
  await expect(
    page
      .getByRole("dialog", { name: "More" })
      .getByRole("link", { name: "Trends" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const toggle = page.getByRole("button", { name: /Morning brief Expand/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.tap();
  const row = page.getByRole("button", { name: /Read Beyond the Black Patch/ });
  await row.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(0);
  await row.tap();
  const reader = page.getByRole("region", { name: "Selected paper" });
  await expect(reader.getByRole("heading", { name: blackPatch })).toBeFocused();
  expect(await reader.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  await expect(nav).toBeHidden();
  await shot();
  await reader.getByRole("button", { name: "Back to the list" }).tap();
  await expect(row).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll);
});

test("paper", async ({ page, shot }, info) => {
  await page.goto("/app/today");
  await openPaper(page, true);
  await expect(
    page.getByRole("region", { name: "Five-part summary" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Paper links" })
      .getByRole("link")
      .first(),
  ).toHaveAttribute("href", /^https:\/\/doi\.org\//);
  await expect(
    page.getByText("HTTP 200 · Checked", { exact: false }),
  ).toBeVisible();
  const sources = page.getByRole("navigation", { name: "Paper links" });
  await expect.soft(sources.getByRole("link")).toHaveCount(1);
  await expect(
    sources.getByRole("link", { name: "Publisher page" }),
  ).toBeVisible();
  await expect(sources.getByText("No open-access PDF found")).toBeVisible();
  const vault = page.getByRole("region", { name: "In your vault" });
  await expect(vault.getByText("Matched by title")).toBeVisible();
  await expect
    .soft(vault.getByRole("link", { name: "Open in Obsidian" }))
    .toHaveAttribute(
      "href",
      "obsidian://open?vault=vault&file=PRIVATE_Vault%2FBlack%20Patch.md",
    );
  await vault.scrollIntoViewIfNeeded();
  await shot("paper-vault");
  const save = page.getByRole("button", {
    name: "Save to library",
    exact: true,
  });
  await save.click();
  await expect(save).toHaveAttribute("aria-pressed", "true");
  await expect(save).toBeDisabled();
  const star = page.getByRole("button", { name: "Star", exact: true });
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "true");
  const rating = page.getByRole("button", { name: "Rate up" });
  await expect(rating).toHaveAttribute("aria-pressed", "false");
  await rating.click();
  await expect(rating).toHaveAttribute("aria-pressed", "true");
  const note = "Walkthrough note (" + info.project.name + ")";
  await page.getByRole("button", { name: "Add note" }).click();
  await page.getByLabel("Note (Markdown)").fill(note);
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await shot();
  const disposable = page
    .getByRole("region", { name: "Quick notes" })
    .getByRole("listitem")
    .filter({ hasText: note });
  await disposable.getByRole("button", { name: "Delete note" }).click();
  await disposable.getByRole("button", { name: "Confirm delete" }).click();
  await expect(disposable).toHaveCount(0);
  await star.click();
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await rating.click();
  await expect(rating).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Link to an idea" }).click();
  const dialog = page.getByRole("dialog", { name: "Link to an idea" });
  await dialog
    .getByRole("combobox", { name: "Idea", exact: true })
    .selectOption({ label: idea + " · PRIVATE_Vision project" });
  await dialog.getByRole("button", { name: "Queue link" }).click();
  await expect(
    page.getByText("Link waiting for sync", { exact: true }).first(),
  ).toBeVisible();
  await cancelRequest(page, /Cancel Beyond the Black Patch/);
  await page.goto("/app/library");
  await removeSavedPaper(page, blackPatch);
});

test("library", async ({ page, shot }, info) => {
  await page.goto("/app/library");
  const openAdd = async () => {
    await page.getByRole("button", { name: "Add paper" }).click();
    return page.getByRole("dialog", { name: "Add a paper" });
  };
  const existing = page.getByRole("row").filter({ hasText: refusal });
  await expect(existing).toBeVisible();
  const status = info.project.name === "phone" ? "archived" : "read";
  await existing
    .getByRole("combobox", { name: /Status for/ })
    .selectOption(status);
  await expect(
    existing.getByRole("combobox", { name: /Status for/ }),
  ).toHaveValue(status);
  await existing.getByRole("button", { name: /^Actions for / }).click();
  await existing.getByRole("button", { name: "Edit tags" }).click();
  await existing
    .getByRole("textbox", { name: "Comma-separated tags" })
    .fill("m4e, " + info.project.name);
  await existing
    .getByRole("textbox", { name: "Comma-separated tags" })
    .press("Enter");
  await expect(existing.getByText("m4e, " + info.project.name)).toBeVisible();
  await page.reload();
  await expect(existing.getByText("m4e, " + info.project.name)).toBeVisible();
  const mirror = page
    .getByRole("row")
    .filter({ hasText: "Review fixture mirror paper" });
  await expect(mirror.getByText("Review folder")).toBeVisible();
  await expect(
    mirror.getByRole("link", { name: "Open in alphaXiv" }),
  ).toHaveAttribute("href", "https://www.alphaxiv.org/abs/2611.12345");
  await expect(mirror.getByRole("combobox")).toHaveCount(0);
  await expect(mirror.getByRole("button", { name: "Edit tags" })).toHaveCount(
    0,
  );
  await expect(page.getByText(/alphaXiv mirror synced/)).toBeVisible();
  await shot();
  let form = await openAdd();
  await form
    .getByLabel("DOI, URL, arXiv ID or title")
    .fill("10.1109/tcsvt.2026.3753367");
  await form.getByRole("button", { name: "Find" }).click();
  await form.getByRole("button", { name: "Add to library" }).click();
  await expect(
    page.getByRole("link", { name: /Anti-Aliasing Token Merging/ }),
  ).toBeVisible();
  await expect(page.getByText(/^Saved ATM:/)).toBeVisible();
  const title = "A recorded preprint without a DOI";
  form = await openAdd();
  await form.getByLabel("DOI, URL, arXiv ID or title").fill(title);
  await form.getByRole("button", { name: "Find" }).click();
  await expect(form.getByText(title, { exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Add to library" }).click();
  await expect(
    page.getByText(`Saved ${title} to your library.`, { exact: true }),
  ).toBeVisible();
  await removeSavedPaper(page, title);
  await removeSavedPaper(page, /Anti-Aliasing Token Merging/);
});

test("projects", async ({ page, shot }) => {
  await page.goto("/app/projects");
  await page.getByRole("link", { name: /^PRIVATE_Vision project/ }).click();
  const project = page.getByRole("region", {
    name: "Project: PRIVATE_Vision project",
  });
  await expect(project.getByText("active", { exact: true })).toBeVisible();
  // The vault path is the Obsidian link's tooltip.
  await expect(
    project.getByRole("link", { name: "Open in Obsidian" }),
  ).toHaveAttribute("title", "PRIVATE_Vault/Project.md");
  await expect(page.getByText("NDA fixture", { exact: true })).toHaveCount(0);
  await shot();
  await project.getByRole("link", { name: /^Ideas 1$/ }).click();
  await expect(project.getByRole("link", { name: idea })).toBeVisible();
  await project.getByRole("link", { name: /^Papers \d+$/ }).click();
  await expect(project.getByRole("link", { name: refusal })).toBeVisible();
  await expect(project.getByRole("link", { name: blackPatch })).toBeVisible();
  await expect
    .soft(project.getByRole("link", { name: "Open in Obsidian" }))
    .toHaveAttribute("href", /file=PRIVATE_Vault%2FProject\.md$/);
});

test("ideas", async ({ page, shot }, info) => {
  await page.goto("/app/ideas");
  await expect
    .soft(
      page.getByText(
        "Captures and moves wait for a sync with vault writes enabled.",
      ),
    )
    .toBeVisible();
  // Phones show the four columns as tabs.
  for (const lane of ["Seed", "Exploring", "In a working paper", "Parked"])
    await expect(
      info.project.name === "phone"
        ? page.getByRole("tab", { name: new RegExp("^" + lane + " \\d") })
        : page.getByRole("region", { name: new RegExp("^" + lane + " ·") }),
    ).toBeVisible();
  const suggestion = page
    .getByRole("region", { name: "Today’s suggestions" })
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "PRIVATE_Try a new baseline (" + info.project.name + ")",
      }),
    });
  await expect(
    suggestion.getByRole("link", { name: blackPatch }),
  ).toBeVisible();
  await shot();
  await suggestion.getByRole("button", { name: "Add to Inbox" }).click();
  await expect(suggestion.getByText("Waiting for sync")).toBeVisible();
  await cancelRequest(
    page,
    "Cancel PRIVATE_Try a new baseline (" + info.project.name + ")",
  );
});

test("working-papers", async ({ page, shot }) => {
  await page.goto("/app/working-papers");
  await page.getByRole("link", { name: draft, exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Its ideas, in the note’s order" })
      .getByText(idea),
  ).toBeVisible();
  const reading = page.getByRole("region", { name: "Reading list" });
  const recent = page.getByRole("region", {
    name: "New this week, close to its ideas",
  });
  const candidate = recent
    .getByRole("listitem")
    .filter({ hasText: "Anti-Aliasing Token Merging" });
  await candidate.getByRole("button", { name: "Add to reading list" }).click();
  await expect(reading.getByText("Waiting for sync")).toBeVisible();
  await shot();
  await cancelRequest(page, /Cancel ATM: Anti-Aliasing Token Merging/);
  await page.goto("/app/working-papers");
  await page.getByRole("link", { name: draft, exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Write in Obsidian" }),
  ).toHaveAttribute("href", /file=PRIVATE_Vault%2FDraft\.md$/);
});

test("vault-sync", async ({ page, shot }, info) => {
  await page.goto("/app/vault");
  await expect(page.getByText("Vault writes are off")).toBeVisible();
  await expect
    .soft(
      page.getByText(
        "Sync runs on your Mac. Requests are applied when the sync has vault writes enabled.",
      ),
    )
    .toBeVisible();
  const last = page.getByRole("region", { name: "Last sync" });
  await expect(last.getByText("1 project", { exact: true })).toBeVisible();
  const conventions = page.getByRole("region", { name: "Vault conventions" });
  await expect(conventions.getByText("type/idea")).toBeVisible();
  await expect(conventions.getByText("type/working-paper")).toBeVisible();
  await expect(conventions.getByText("1 excluded folder")).toBeVisible();
  await expect(
    conventions.getByText("PRIVATE_Vault/Black Patch.md"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Waiting for sync" })
      .getByText("PRIVATE_Queued capture"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Needs review" })
      .getByText("The idea note changed since it was indexed."),
  ).toBeVisible();
  await conventions.scrollIntoViewIfNeeded();
  await shot();
  const directory = info.outputPath("vault");
  mkdirSync(join(directory, "PRIVATE_Vault"), { recursive: true });
  mkdirSync(join(directory, "NDA fixture"), { recursive: true });
  const files = {
    "PRIVATE_Vault/Project.md":
      "---\ntitle: PRIVATE_Vision project\nstatus: active\n---\n",
    "PRIVATE_Vault/Idea.md":
      "---\ntitle: PRIVATE_Depth idea\ntags: [type/idea]\nstatus: seed\n---\n",
    "PRIVATE_Vault/Draft.md":
      "---\ntitle: PRIVATE_Depth draft\ntags: [type/working-paper]\n---\n",
    "PRIVATE_Vault/Black Patch.md": "---\ntags: [type/paper]\n---\n",
    "NDA fixture/Omit.md": "Excluded fixture note.",
    "Inbox.md": "# Inbox\n",
  };
  for (const [path, contents] of Object.entries(files))
    writeFileSync(join(directory, path), contents);
  const result = await localCli(["sync", "--dry-run"], directory);
  expect(result).toMatchObject({
    dryRun: true,
    index: "planned",
    counts: { project: 1, idea: 1, working_paper: 1, paper_note: 1 },
    conventions: {
      excludedFolders: 1,
      paperNotesWithoutIdentifiers: { count: 1 },
    },
  });
  expect(result.writes.length).toBeGreaterThan(0);
  for (const write of result.writes) {
    expect(write.mode).toBe("planned");
    expect(write.path).toMatch(/^(Inbox\.md$|digests-new\/)/);
  }
  for (const [path, contents] of Object.entries(files))
    expect(readFileSync(join(directory, path), "utf8")).toBe(contents);
});

test("health", async ({ page, shot }) => {
  await page.goto("/app/health");
  const delivery = page.getByRole("list", { name: "Digest delivery by day" });
  await expect(delivery.getByRole("listitem")).toHaveCount(30);
  await expect(delivery.getByText(/No listing/).first()).toBeAttached();
  await expect(delivery.getByText(/Missed/).first()).toBeAttached();
  await expect(page.getByText(/11:30/)).toBeVisible();
  await expect
    .soft(page.getByText(/UTC day · Resets .*08:00 GMT\+8/))
    .toBeVisible();
  await expect
    .soft(page.getByText(/Reading day \d{1,2} [A-Z][a-z]{2} \d{4}/))
    .toBeVisible();
  await expect(page.getByText(/used \/ 80,000/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recent runs" }),
  ).toBeVisible();
  await expect(page.getByText("14,320 rows written")).toBeVisible();
  await expect(page.getByText("Codex (fallback)")).toBeVisible();
  await expect(page.getByText("Claude", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Mirror completed 16 Nov 2026, 12:42/),
  ).toBeVisible();
  await shot();
});

test("settings", async ({ page, shot }, info) => {
  await page.goto("/app/settings");
  await page.getByRole("radio", { name: "Dark" }).check();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "graphite");
  await expect(
    page.getByRole("listitem").filter({ hasText: /^Vision$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({ hasText: /^Language$/ }),
  ).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download export bundle" }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(
    /^litscout-backup-.*\.json\.gz$/,
  );
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  try {
    const verified = execFileSync(
      process.execPath,
      ["--import", "tsx", "apps/cli/src/index.ts", "backup", "--verify", path],
      { encoding: "utf8" },
    );
    expect(verified).toMatch(/verified/i);
  } finally {
    rmSync(path, { force: true });
  }
  await shot();
});

test("public", async ({ page, shot }) => {
  const paths: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/api/v1/")) paths.push(pathname);
  });
  await page.goto("/public/today");
  await expect(page.getByText("Public feed · Read only")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tuesday 17 November" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Morning brief" })).toHaveCount(
    0,
  );
  await shot("public-today");
  await page.getByRole("link", { name: "Days", exact: true }).click();
  await page
    .getByRole("region", { name: "Calendar" })
    .getByRole("button", { name: new RegExp("^" + day + ":") })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tuesday 17 November" }),
  ).toBeVisible();
  await shot("public-day");
  await openPaper(page, true);
  await expect(page).toHaveURL(/\/public\/papers\/pap_/);
  await expect(
    page.getByRole("region", { name: "Five-part summary" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Paper links" })
      .getByRole("link")
      .first(),
  ).toHaveAttribute("href", /^https:\/\/doi\.org\//);
  await expect(
    page.getByRole("region", { name: /Quick notes|In your vault/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Save to library|Capture idea|Link to an idea/,
    }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("PRIVATE_");
  expect(paths).toContain("/api/v1/public/days/" + day);
  expect(
    paths.every(
      (path) =>
        path === "/api/v1/instance" || path.startsWith("/api/v1/public/"),
    ),
  ).toBe(true);
  await shot();
});

test("keyboard", async ({ page, shot }, info) => {
  await page.goto("/app/today");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  const trigger = page.getByRole("button", { name: "Search papers" });
  await expect(trigger).toBeVisible();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "Search papers" });
  // The search input, not the Type filter beside it.
  const input = search.getByRole("combobox", {
    name: "Search titles and authors",
  });
  await expect(input).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Search papers" }),
  ).toBeFocused();
  if (info.project.name === "phone") {
    const more = page.getByRole("button", { name: "More", exact: true });
    await tabTo(page, more);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
  }
  await tabTo(page, page.getByRole("link", { name: "Ideas", exact: true }));
  await page.keyboard.press("Enter");
  const lane = (name: string) =>
    info.project.name === "phone"
      ? page.getByRole("tabpanel", { name: new RegExp("^" + name + " \\d") })
      : page.getByRole("region", { name: new RegExp("^" + name + " ·") });
  const seed = lane("Seed");
  const exploring = lane("Exploring");
  const actions = seed.getByRole("button", { name: "Actions for " + idea });
  await tabTo(page, actions);
  // Open the card's menu (focus lands on its first move, Exploring) and
  // choose it.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const cancel = exploring.getByRole("button", {
    name: "Cancel move for " + idea,
  });
  await expect(cancel).toBeFocused();
  await shot();
  await page.keyboard.press("Enter");
  await expect(actions).toBeFocused();
  await expect(cancel).toHaveCount(0);
});
