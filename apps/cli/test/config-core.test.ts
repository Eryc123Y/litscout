import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { coreModule } from "../src/config-loader";

it("points config imports at the installed core package", () => {
  expect(coreModule()).toMatch(/packages[/\\]core[/\\]/);
});

it("falls back to the defineConfig module shipped beside a built CLI", () => {
  const base = pathToFileURL(path.join("/srv/app/dist", "index.js")).href;
  const missing = () => {
    throw Object.assign(new Error("not found"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
  expect(coreModule(missing, base)).toBe(
    path.join("/srv/app/dist", "config-core.mjs"),
  );
});
