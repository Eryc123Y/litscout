import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("S7 pins the PDF parser consistently and makes high-severity audit part of the merge gate", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8")),
    cli = JSON.parse(readFileSync("apps/cli/package.json", "utf8"));
  expect(root.dependencies["pdfjs-dist"]).toBe("6.5.438");
  expect(cli.dependencies["pdfjs-dist"]).toBe("6.5.438");
  // `pnpm verify` is the local merge gate; the manual workflow runs the same.
  expect(root.scripts.verify).toMatch(/^pnpm audit --audit-level high && /);
  expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
    "run: pnpm verify",
  );
});
