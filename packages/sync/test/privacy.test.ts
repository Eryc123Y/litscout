import { expect, it } from "vitest";
import { planLegacy } from "../src/legacy";
it("S6 derives ratings and ledger picks without retaining private source files in cursors", () => {
  const privateText = "DO_NOT_UPLOAD_PRIVATE_BRIEF";
  const plan = planLegacy(
    {
      "assets/feed-cursor.json": '{"since":"2026-11-10","at":"old timestamp"}',
      "assets/venues.json": '{"private":"DO_NOT_UPLOAD"}',
    },
    {
      "project-brief.md": privateText,
      "feedback.md": `2026-11-10 2611.00001 up\n${privateText}`,
      "ledger.json": JSON.stringify({
        items: [{ date: "2026-11-10", id: "2611.00001" }],
      }),
      "ledger.md": privateText,
    },
    { from: "2026-11-10", to: "2026-11-11" },
  );
  expect(plan.ratings).toHaveLength(1);
  expect(plan.ledger).toHaveLength(1);
  expect(plan.cursors).toEqual([
    { name: "venue-feed", value: '{"since":"2026-11-10"}' },
  ]);
  expect(JSON.stringify(plan)).not.toContain(privateText);
});
