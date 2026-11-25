import { build } from "vite";
import { webRuntime } from "@litscout/worker/test/helpers/web-runtime";
import { reviewResolution } from "@litscout/worker/test/helpers/web-review";
const review = process.env.LITSCOUT_REVIEW_WALKTHROUGH === "1";
await build({ root: "apps/web" });
const runtime = await webRuntime({
  assets: "apps/web/dist",
  port: 4173,
  researchFixtures: true,
  longBriefFixture: true,
  unmatchedFixture: true,
  ...(review && { reviewFixtures: true, outboundService: reviewResolution }),
  trendsFixtures: true,
  publicLimitOff: true,
  backupCooldownOff: true,
});
await runtime.ready;
process.stdout.write(
  "Local fixture Worker ready: http://127.0.0.1:4173 (outbound network disabled)\n",
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void runtime.dispose().then(() => process.exit(0));
  });
