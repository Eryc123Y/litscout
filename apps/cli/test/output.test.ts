import { expect, it } from "vitest";
import { streamExitCode, output } from "../src/output";
it("uses the public command exit code contract for inherited streaming commands", () => {
  expect(streamExitCode(2, false, false)).toBe(1);
  expect(streamExitCode(0, false, false)).toBe(2);
  expect(streamExitCode(0, true, false)).toBe(0);
  expect(streamExitCode(0, false, true)).toBe(0);
  expect(streamExitCode(1, false, false)).toBe(1);
});
it("keeps human messages readable and JSON output machine readable", () => {
  const lines: string[] = [];
  output((s) => lines.push(s), false, { messages: ["One", "Two"] });
  output((s) => lines.push(s), false, { commands: ["wrangler whoami"] });
  output((s) => lines.push(s), true, { messages: ["One"] });
  expect(lines).toEqual([
    "One\nTwo",
    "wrangler whoami",
    '{"success":true,"data":{"messages":["One"]}}',
  ]);
});
