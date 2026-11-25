import { expect, test } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { backupBundleSchema } from "@litscout/pipeline/backup-contracts";
import { openMoreOnPhone } from "./navigation";

test("the private reader shows Health and downloads a valid export", async ({
  page,
}) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto("/public/today");
  await expect(
    page.getByRole("link", { name: "Health", exact: true }),
  ).toHaveCount(0);
  await page.goto("/app/today");
  await openMoreOnPhone(page);
  await page.getByRole("link", { name: "Health", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Digest delivery" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Page updates" })).toHaveText(
    "Health loaded.",
  );
  await expect(
    page
      .getByRole("list", { name: "Digest delivery by day" })
      .getByRole("listitem"),
  ).toHaveCount(30);
  await openMoreOnPhone(page);
  await page.getByRole("link", { name: "Settings" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download export bundle" }).click();
  const download = await downloadEvent;
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status", { name: "Page updates" })).toHaveText(
    "Download started.",
  );
  expect(download.suggestedFilename()).toMatch(
    /^litscout-backup-.*\.json\.gz$/,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(Buffer.from(chunk));
  const bundle = backupBundleSchema.parse(
    JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")),
  );
  expect(bundle.instanceName).toBe("LitScout");
  // Other specs share this fixture Worker and may add notes or digests first,
  // so check for the seeded rows instead of exact counts.
  expect(bundle.data.quickNotes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "note_private", body_md: "PRIVATE_NOTE" }),
    ]),
  );
  expect(bundle.data.digests.length).toBeGreaterThanOrEqual(1);
  expect(bundle.data.papers.length).toBeGreaterThan(0);
});
