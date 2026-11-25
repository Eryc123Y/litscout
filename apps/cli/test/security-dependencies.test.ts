import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("S7 pins the PDF parser consistently and makes high-severity audit part of the merge gate", () => {
  const root = JSON.parse(readFileSync("package.json", "utf8")),
    cli = JSON.parse(readFileSync("apps/cli/package.json", "utf8"));
  expect(root.dependencies["pdfjs-dist"]).toBe("6.5.438");
  expect(cli.dependencies["pdfjs-dist"]).toBe("6.5.438");
  // `pnpm verify` is the local merge gate; the workflow runs every step of it,
  // split into parallel jobs.
  const steps = (command: string): string[] =>
    command
      .split("&&")
      .map((step) => step.trim())
      .flatMap((step) =>
        step === "pnpm check" ? steps(root.scripts.check) : [step],
      );
  const gate = steps(root.scripts.verify);
  expect(gate[0]).toBe("pnpm audit --audit-level high");
  expect(gate).toContain("pnpm test:coverage");
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  for (const step of gate) expect(workflow).toContain(`run: ${step}`);
});
