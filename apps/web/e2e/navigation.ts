import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export async function openMoreOnPhone(page: Page) {
  if (page.viewportSize()!.width < 768)
    await page.getByRole("button", { name: "More", exact: true }).click();
}

/** The WCAG 2.1 A and AA axe results for the page, minus one accepted
 * exception: the text contrast of a read paper's row. Those rows fade to 45%
 * on purpose (chosen on 21 Nov 2026) and come back to full ink when
 * open, hovered or focused. Every other rule still applies to them. */
export async function axeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const kept: typeof violations = [];
  for (const violation of violations) {
    if (violation.id !== "color-contrast") {
      kept.push(violation);
      continue;
    }
    const nodes: typeof violation.nodes = [];
    for (const node of violation.nodes) {
      const faded = await page
        .locator(String(node.target[0]))
        .first()
        .evaluate((el) => el.closest(".reader-row[data-read]") !== null)
        .catch(() => false);
      if (!faded) nodes.push(node);
    }
    if (nodes.length > 0) kept.push({ ...violation, nodes });
  }
  return kept;
}
