import { expect, test as base, type Page } from "@playwright/test";
import { axeViolations } from "./navigation";

const test = base.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-17T04:00:00Z") });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === "http://127.0.0.1:4173"
      ? route.continue()
      : route.abort(),
  );
});

async function checkAccessibility(page: Page) {
  const violations = await axeViolations(page);
  // Finish fixture cleanup even when the accessibility assertion fails.
  expect.soft(violations).toEqual([]);
}

const idea = "PRIVATE_Depth idea";
const draft = "PRIVATE_Depth draft";
const paper = /Beyond the Black Patch/;

async function openReader(page: Page, path = "/app/today") {
  await page.goto(path);
  await page
    .getByRole("button", { name: /Read Beyond the Black Patch/ })
    .click();
  const reader = page.getByRole("article", { name: paper });
  await expect(reader).toBeVisible();
  return reader;
}

/** An Ideas column: a region on desktop, a tab's panel on a phone. */
function lane(page: Page, name: string, phone: boolean) {
  return phone
    ? page.getByRole("tabpanel", { name: new RegExp("^" + name + " \\d") })
    : page.getByRole("region", { name: new RegExp("^" + name + " ·") });
}
const lanes = ["Seed", "Exploring", "In a working paper", "Parked"];

test("moves an idea with the keyboard and cancels the move", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await page.goto("/app/ideas");
  const seed = lane(page, "Seed", phone);
  const exploring = lane(page, "Exploring", phone);
  for (const name of lanes)
    await expect(
      phone
        ? page.getByRole("tab", { name: new RegExp("^" + name + " \\d") })
        : lane(page, name, phone),
    ).toBeVisible();
  const card = seed.getByRole("article").filter({ hasText: idea });
  const actions = card.getByRole("button", { name: "Actions for " + idea });

  // Move to lives in the card's menu. Opening it moves focus to the first
  // item; tabbing out of the menu closes it.
  await actions.focus();
  await page.keyboard.press("Enter");
  const moveTo = page.getByRole("button", { name: "Move to Exploring" });
  await expect(moveTo).toBeFocused();
  for (let item = 0; item < 3; item++) await page.keyboard.press("Tab");
  await expect(moveTo).toBeHidden();
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(moveTo).toBeFocused();
  await page.keyboard.press("Enter");

  const moved = exploring.getByRole("article").filter({ hasText: idea });
  await expect(
    moved.getByText("Waiting for sync", { exact: true }),
  ).toBeVisible();
  await expect
    .soft(page.getByRole("status", { name: "Page updates" }))
    .toHaveText("Idea move requested. Waiting for sync.");
  await expect(card).toHaveCount(0);
  const cancel = moved.getByRole("button", { name: "Cancel move for " + idea });
  await expect(cancel).toBeFocused();
  await checkAccessibility(page);
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible();
  await expect(moved).toHaveCount(0);
  await expect(actions).toBeFocused();
});

test("drags an idea by its grip with the keyboard, then with the pointer", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await page.goto("/app/ideas");
  const seed = lane(page, "Seed", phone);
  const exploring = lane(page, "Exploring", phone);
  const card = seed.getByRole("article").filter({ hasText: idea });
  const grip = card.getByRole("button", { name: "Drag " + idea });
  const updates = page.getByRole("status", { name: "Page updates" });

  // Keyboard: pick up, move one column right, then cancel with Escape.
  await grip.focus();
  await page.keyboard.press("Space");
  await expect(grip).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect.soft(updates).toHaveText("Over Exploring.");
  await page.keyboard.press("Escape");
  await expect(grip).toHaveAttribute("aria-pressed", "false");
  await expect(card).toBeVisible();

  // Keyboard: pick up, move right, drop.
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  const moved = exploring.getByRole("article").filter({ hasText: idea });
  await expect(
    moved.getByText("Waiting for sync", { exact: true }),
  ).toBeVisible();
  await moved.getByRole("button", { name: "Cancel move for " + idea }).click();
  await expect(card).toBeVisible();

  // Pointer: press the grip, drag over Exploring (its tab on a phone) and
  // release.
  const target = phone
    ? page.getByRole("tab", { name: /^Exploring \d/ })
    : exploring;
  const from = await grip.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 30, from!.y + 10, { steps: 4 });
  await page.mouse.move(
    to!.x + to!.width / 2,
    to!.y + Math.min(40, to!.height / 2),
    { steps: 8 },
  );
  await expect(target).toHaveClass(/ring-primary/);
  await page.mouse.up();
  await expect(
    moved.getByText("Waiting for sync", { exact: true }),
  ).toBeVisible();
  await moved.getByRole("button", { name: "Cancel move for " + idea }).click();
  await expect(card).toBeVisible();
});

test("captures an idea in the reader, then edits and cancels it", async ({
  page,
}, testInfo) => {
  const reader = await openReader(page);
  const trigger = reader.getByRole("button", { name: "Capture idea" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Capture idea" });
  const title = dialog.getByRole("textbox", { name: "Title", exact: true });
  const close = dialog.getByRole("button", { name: "Close", exact: true });

  await expect(title).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(title).toBeFocused();
  await checkAccessibility(page);
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(reader).toBeVisible();

  await page.keyboard.press("Enter");
  await title.fill("PRIVATE_Reader capture");
  await dialog
    .getByRole("textbox", { name: "Note (Markdown, optional)" })
    .fill("A short fixture note.");
  await dialog.getByRole("button", { name: "Queue capture" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(reader.getByText("Capture waiting for sync")).toBeVisible();

  if (testInfo.project.name === "phone")
    await page.getByRole("button", { name: "Back to the list" }).click();
  await page.getByRole("link", { name: "Ideas", exact: true }).click();
  const captures = page.getByRole("region", { name: /^Captured here/ });
  const capture = captures
    .getByRole("article")
    .filter({ hasText: "PRIVATE_Reader capture" });
  await expect(capture.getByText(paper)).toBeVisible();
  await capture
    .getByRole("button", { name: "Edit before sync: PRIVATE_Reader capture" })
    .click();
  const edit = page.getByRole("dialog", { name: "Edit capture" });
  await expect(
    edit.getByRole("textbox", { name: "Note (Markdown, optional)" }),
  ).toHaveValue("A short fixture note.");
  await edit
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("PRIVATE_Edited capture");
  await edit.getByRole("button", { name: "Save capture" }).click();
  const edited = captures
    .getByRole("article")
    .filter({ hasText: "PRIVATE_Edited capture" });
  await expect(
    edited.getByRole("heading", { name: "PRIVATE_Edited capture" }),
  ).toBeVisible();
  await edited
    .getByRole("button", { name: "Cancel PRIVATE_Edited capture" })
    .click();
  await expect(edited).toHaveCount(0);
});

test("links a paper to an idea from its full record", async ({ page }) => {
  const reader = await openReader(page);
  await reader.getByRole("link", { name: "Open full record" }).click();
  await expect(page).toHaveURL(/\/app\/papers\/pap_/);
  const panel = page.getByRole("region", { name: "In your vault" });
  await expect(panel.getByText("Matched by title")).toBeVisible();
  await page.reload();
  await expect(panel.getByText("Matched by title")).toBeVisible();
  await expect(panel.getByText("PRIVATE_Vault/Black Patch.md")).toBeVisible();

  const trigger = page.getByRole("button", { name: "Link to an idea" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Link to an idea" });
  const ideas = dialog.getByRole("combobox", { name: "Idea", exact: true });
  await ideas.selectOption({ label: idea + " · PRIVATE_Vision project" });
  await dialog.getByRole("button", { name: "Queue link" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  const record = page.getByRole("article", { name: paper });
  await expect.soft(record.getByText("Link waiting for sync")).toBeVisible();
  await expect
    .soft(page.getByRole("status", { name: "Page updates" }))
    .toHaveText("Link waiting for sync");

  await page.goto("/app/vault");
  const request = page
    .getByRole("region", { name: "Waiting for sync" })
    .getByRole("listitem")
    .filter({ hasText: paper });
  await expect(request.getByText("PRIVATE_Vault/Idea.md")).toBeVisible();
  await request
    .getByRole("button", { name: /Cancel Beyond the Black Patch/ })
    .click();
  await expect(request).toHaveCount(0);
});

test("accepts a new idea from the Today brief and dismisses another", async ({
  page,
}, testInfo) => {
  await page.goto("/app/today");
  const brief = page.getByRole("region", { name: "Morning brief" });
  if (testInfo.project.name === "phone")
    await brief.getByRole("button", { name: "Morning brief Expand" }).click();
  const suggestions = brief.getByRole("region", { name: "Idea suggestions" });
  const acceptedTitle =
    "PRIVATE_Try a new baseline (" + testInfo.project.name + ")";
  const dismissedTitle =
    "PRIVATE_Compare viewing tasks (" + testInfo.project.name + ")";
  const accepted = suggestions
    .getByRole("article")
    .filter({ hasText: acceptedTitle });
  const dismissed = suggestions
    .getByRole("article")
    .filter({ hasText: dismissedTitle });
  const updates = page.getByRole("status", { name: "Page updates" });

  // The preview orders suggestions by ID, so either desktop fixture can be
  // outside the first three titles. Phone already shows the whole list.
  if (testInfo.project.name === "desktop")
    await suggestions
      .getByRole("button", { name: /Show .* more suggestions?$/ })
      .click();
  await expect(accepted.getByText("New idea", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1);
  await accepted.getByRole("button", { name: "Add to Inbox" }).click();
  await expect(
    accepted.getByText("Waiting for sync", { exact: true }),
  ).toBeVisible();
  await expect(updates).toHaveText("Suggestion accepted. Waiting for sync.");
  await dismissed.getByRole("button", { name: "Dismiss" }).click();
  await expect(dismissed).toHaveCount(0);
  await expect(suggestions.getByText("Suggestion dismissed.")).toBeVisible();
  await expect(updates).toHaveText("Suggestion dismissed.");
  await expect(page.getByRole("status")).toHaveCount(1);

  await page.goto("/app/vault");
  const cancel = page.getByRole("button", {
    name: "Cancel " + acceptedTitle,
    exact: true,
  });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(cancel).toHaveCount(0);
});

test("adds a new-this-week paper to a working paper's reading list", async ({
  page,
}) => {
  await page.goto("/app/working-papers");
  await page.getByRole("link", { name: draft, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: draft, exact: true }),
  ).toBeVisible();
  const recent = page.getByRole("region", {
    name: "New this week, close to its ideas",
  });
  const candidate = recent
    .getByRole("listitem")
    .filter({ hasText: "Anti-Aliasing Token Merging" });
  await candidate.getByRole("button", { name: "Add to reading list" }).click();
  const entry = page
    .getByRole("region", { name: "Reading list" })
    .getByRole("listitem")
    .filter({
      hasText: "Anti-Aliasing Token Merging",
    });
  await expect(
    entry.getByText("Waiting for sync", { exact: true }),
  ).toBeVisible();
  await expect
    .soft(page.getByRole("status", { name: "Page updates" }))
    .toHaveText("Reading list addition requested. Waiting for sync.");
  await expect(candidate).toHaveCount(0);

  await page.goto("/app/vault");
  const cancel = page.getByRole("button", {
    name: /Cancel ATM: Anti-Aliasing Token Merging/,
  });
  await cancel.click();
  await expect(cancel).toHaveCount(0);
});

test("shows writes off, waiting requests and a rejected request", async ({
  page,
}) => {
  await page.goto("/app/vault");
  await expect(
    page.getByText("Vault writes are off", { exact: true }),
  ).toBeVisible();
  const waiting = page.getByRole("region", { name: "Waiting for sync" });
  for (const title of ["PRIVATE_Queued capture", "PRIVATE_Queued follow-up"])
    await expect(
      waiting.getByRole("button", { name: "Cancel " + title, exact: true }),
    ).toBeEnabled();
  const rejected = page.getByRole("region", { name: "Needs review" });
  await expect(rejected.getByText(paper)).toBeVisible();
  await expect(
    rejected.getByText("The idea note changed since it was indexed."),
  ).toBeVisible();
  await checkAccessibility(page);
});

test("reads project, idea and draft notes read-only", async ({
  page,
}, testInfo) => {
  await page.goto("/app/projects");
  // The project opens beside the list (on a phone, on its own); its note
  // reads in the project's Note section.
  await page.getByRole("link", { name: /^PRIVATE_Vision project/ }).click();
  const project = page.getByRole("region", {
    name: "Project: PRIVATE_Vision project",
  });
  await project.getByRole("link", { name: "Note", exact: true }).click();
  await expect(
    project.getByRole("heading", { name: "PRIVATE_Vision plan" }),
  ).toBeVisible();
  await expect(project.getByText("Read the depth papers first.")).toBeVisible();
  await expect(project.getByRole("cell", { name: "Baseline" })).toBeVisible();
  await expect(project.getByRole("checkbox", { name: "Done" })).toBeChecked();
  await expect(
    project.getByText("See the depth idea and ~5% gains."),
  ).toBeVisible();
  await checkAccessibility(page);
  // A linked paper reads in the same column; Escape goes back to the list.
  await project.getByRole("link", { name: /^Papers \d+$/ }).click();
  await project
    .getByRole("link", { name: /Forcing a Letter Suppresses Refusal/ })
    .click();
  const back = project.getByRole("button", {
    name: "Back to PRIVATE_Vision project",
  });
  await expect(back).toBeVisible();
  await checkAccessibility(page);
  await page.keyboard.press("Escape");
  await expect(back).toHaveCount(0);
  await expect(
    project.getByRole("link", { name: /Forcing a Letter Suppresses Refusal/ }),
  ).toBeVisible();

  await page.goto("/app/ideas");
  const ideas = lane(page, "Seed", testInfo.project.name === "phone");
  await ideas.getByRole("link", { name: "Read note: " + idea }).click();
  const ideaPanel = page.getByRole("complementary", { name: "Note: " + idea });
  await expect(ideaPanel.getByText("stereo", { exact: true })).toBeVisible();
  await expect(ideaPanel).toContainText(
    "Read-only. Edit the note in Obsidian.",
  );
  await checkAccessibility(page);
  await page.keyboard.press("Escape");
  await expect(ideaPanel).toHaveCount(0);

  await page.goto("/app/working-papers");
  await page.getByRole("link", { name: draft, exact: true }).click();
  await expect(page.getByRole("region", { name: "Draft note" })).toContainText(
    "text stays in your vault",
  );
});

test("keeps private research data off the public day and feed", async ({
  page,
  request,
}) => {
  const apiUrls = new Set<string>();
  page.on("request", (request) => {
    const { pathname, search } = new URL(request.url());
    if (pathname.startsWith("/api/v1/")) apiUrls.add(pathname + search);
  });

  for (const path of ["/public/days/2026-11-17", "/public/today"]) {
    const reader = await openReader(page, path);
    await expect(
      page.getByText("Public feed · Read only").filter({ visible: true }),
    ).toBeVisible();
    await expect(
      reader.getByRole("link", { name: "Open full record" }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("PRIVATE_");
    await expect(
      page.getByRole("link", { name: /^(Ideas|Working papers|Vault sync)$/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: /^(Captured here|Idea suggestions|In your vault)/,
      }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: /^(Capture idea|Link to an idea)$/ }),
    ).toHaveCount(0);
    expect(await page.content()).not.toContain("PRIVATE_");
  }

  expect(
    [...apiUrls].some((url) => url.startsWith("/api/v1/public/days/")),
  ).toBe(true);
  expect(
    [...apiUrls].some((url) => url.startsWith("/api/v1/public/papers/")),
  ).toBe(true);
  for (const url of apiUrls) {
    if (url === "/api/v1/instance") continue;
    expect(url).toMatch(/^\/api\/v1\/public\//);
    const response = await request.get(url);
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toMatch(
      /PRIVATE_|"(?:ideas|captures|suggestions|workingPapers|vaultPath|path)":/,
    );
  }
});
