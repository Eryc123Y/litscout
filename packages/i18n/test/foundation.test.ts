import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies i18n", () => expect(packageName).toBe("i18n"));
