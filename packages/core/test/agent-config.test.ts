import { expect, it } from "vitest";
import {
  agentModelSchema,
  agentCommandSchema,
  commandValues,
} from "../src/agent-config";
it("S8 validates identifiers and command argument values independently of executable options", () => {
  for (const model of [
    "m",
    "provider:model.v1",
    "model-1",
    "name_with_underscore",
  ])
    expect(agentModelSchema.parse(model)).toBe(model);
  for (const model of ["", "--flag", "a b", "a\nb", "model\n", "x".repeat(129)])
    expect(agentModelSchema.safeParse(model).success).toBe(false);
  for (const value of [
    [],
    [""],
    ["--flag", "{prompt}"],
    ["cli", "--model"],
    ["cli", "-m", ""],
    ["cli", "-p", "--flag"],
  ])
    expect(agentCommandSchema.safeParse(value).success).toBe(false);
  expect(agentCommandSchema.parse(["cli", "--tools", "", "{prompt}"])).toEqual([
    "cli",
    "--tools",
    "",
    "{prompt}",
  ]);
  expect(
    commandValues(
      ["cli", "--model", "{model}", "-p", "{prompt}"],
      "Input",
      "model.v1",
    ),
  ).toEqual(["cli", "--model", "model.v1", "-p", "Input"]);
  expect(commandValues(["cli", "{prompt}"], "Input")).toEqual(["cli", "Input"]);
  expect(() => commandValues(["cli"], "Input")).toThrow("{prompt}");
  expect(() => commandValues(["cli", "{prompt}"], "--flag")).toThrow();
  expect(() =>
    commandValues(["cli", "--model", "{model}", "{prompt}"], "Input"),
  ).toThrow();
});
