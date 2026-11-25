// Local only: screenshots of the reader on a real-data Worker started by
// tools/real-data-local.mjs, at desktop and phone sizes, plus a layout check
// for horizontal overflow and an axe check (WCAG 2.1 A and AA, the tags the
// e2e suite uses). Output stays under .artifacts/real-data/.
//
//   node tools/real-data-shots.mjs https://127.0.0.1:4175 2026-11-16 2026-11-17 2026-11-18
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

// axe is a dev dependency of the web app, so resolve it from there.
const { default: AxeBuilder } = await import(
  createRequire(new URL("../apps/web/package.json", import.meta.url)).resolve(
    "@axe-core/playwright",
  )
);

const viewports = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  {
    name: "phone",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
];

/** Pick the papers whose shapes stress the layout. */
export function stressPapers(items) {
  const by = (score) =>
    [...items].sort((a, b) => score(b) - score(a)).slice(0, 5);
  const pick = new Map();
  const add = (reason, list) => {
    for (const item of list)
      if (!pick.has(item.paperId)) pick.set(item.paperId, { ...item, reason });
  };
  add(
    "longest title",
    by((p) => p.title.length),
  );
  add(
    "most authors",
    by((p) => p.authors?.length ?? 0),
  );
  add(
    "LaTeX in title",
    items.filter((p) => /\$|\\[a-zA-Z]+/.test(p.title)).slice(0, 2),
  );
  add("no abstract", items.filter((p) => !p.abstract).slice(0, 2));
  add("venue", items.filter((p) => p.source !== "arxiv").slice(0, 2));
  return [...pick.values()];
}

// Elements wider than the viewport, and whether the page scrolls sideways.
function layoutReport() {
  const width = document.documentElement.clientWidth;
  const wide = [];
  for (const el of document.querySelectorAll("body *")) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.right <= width + 1) continue;
    let scroller = el.parentElement;
    while (scroller && getComputedStyle(scroller).overflowX === "visible")
      scroller = scroller.parentElement;
    if (
      scroller &&
      scroller !== document.body &&
      scroller !== document.documentElement
    )
      continue;
    wide.push(
      el.tagName.toLowerCase() +
        (el.className && typeof el.className === "string"
          ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
          : "") +
        " right=" +
        Math.round(box.right),
    );
    if (wide.length >= 8) break;
  }
  return {
    scrollsSideways: document.documentElement.scrollWidth > width + 1,
    wide,
  };
}

async function shoot(page, out, name, url, report) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, name + ".png") });
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  report.push({
    name,
    url: new URL(url).pathname,
    ...(await page.evaluate(layoutReport)),
    axe: violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      sample: v.nodes[0]?.target?.join(" ") ?? "",
    })),
  });
}

async function main() {
  const [origin, ...days] = process.argv.slice(2);
  if (!origin || !days.length)
    throw new Error("Use: real-data-shots.mjs ORIGIN DAY [DAY ...]");
  // A local Worker only: the browser ignores certificate errors for it.
  const url = new URL(origin);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.origin !== origin
  )
    throw new Error(
      "ORIGIN must be a local origin such as https://127.0.0.1:4175",
    );
  if (!days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))
    throw new Error("Each DAY must be YYYY-MM-DD");
  const out = fileURLToPath(
    new URL("../.artifacts/real-data/", import.meta.url),
  );
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  try {
    for (const size of viewports) {
      const context = await browser.newContext({
        ...size,
        ignoreHTTPSErrors: true,
      });
      const page = await context.newPage();
      for (const day of days) {
        await shoot(
          page,
          out,
          `${size.name}-day-${day}`,
          `${origin}/app/days/${day}`,
          report,
        );
      }
      await shoot(page, out, `${size.name}-days`, `${origin}/app/days`, report);
      await shoot(
        page,
        out,
        `${size.name}-trends`,
        `${origin}/app/trends`,
        report,
      );
      await shoot(
        page,
        out,
        `${size.name}-public-${days.at(-1)}`,
        `${origin}/public/days/${days.at(-1)}`,
        report,
      );
      // Page through the whole day so the stress picks see every paper.
      const items = await page.evaluate(async (day) => {
        const all = [];
        let cursor = null;
        for (let page = 0; page < 60; page++) {
          const query = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
          const res = await fetch(`/api/v1/feed/days/${day}${query}`);
          if (!res.ok) break;
          const body = await res.json();
          const data = body.data ?? body;
          all.push(...(data.items ?? []));
          cursor = data.nextCursor;
          if (!cursor) break;
        }
        return all;
      }, days.at(-1));
      process.stdout.write(
        `${size.name}: ${items.length} papers on ${days.at(-1)}\n`,
      );
      for (const [index, paper] of stressPapers(items).entries()) {
        await shoot(
          page,
          out,
          `${size.name}-paper-${index + 1}`,
          `${origin}/app/papers/${paper.paperId}?day=${days.at(-1)}`,
          report,
        );
        Object.assign(report.at(-1), {
          reason: paper.reason,
          titleLength: paper.title.length,
          authors: paper.authors?.length ?? 0,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  await writeFile(
    path.join(out, "layout.json"),
    JSON.stringify(report, null, 2),
  );
  for (const r of report)
    process.stdout.write(
      `${r.scrollsSideways || r.wide.length ? "WIDE" : "ok  "} ${r.axe.length ? "AXE " : "    "}${r.name}${r.reason ? " (" + r.reason + ")" : ""}${r.wide.length ? " " + r.wide.join(", ") : ""}${r.axe.map((v) => ` [${v.impact} ${v.id} x${v.nodes}: ${v.sample}]`).join("")}\n`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
