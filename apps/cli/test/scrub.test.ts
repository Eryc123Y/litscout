import { readFileSync, existsSync } from "node:fs";
import { expect, it } from "vitest";
it("ships a placeholder configuration and no legacy sign-in code", () => {
  expect(existsSync("apps/worker/src/auth/github.ts")).toBe(false);
  expect(existsSync("apps/worker/src/auth/allowlist.ts")).toBe(false);
  expect(existsSync("wrangler.jsonc")).toBe(false);
  expect(readFileSync("apps/worker/wrangler.template.jsonc", "utf8")).toContain(
    "KV_NAMESPACE_ID",
  );
  expect(readFileSync("apps/worker/src/env.ts", "utf8")).not.toMatch(
    /GITHUB|MAILTO/,
  );
});
