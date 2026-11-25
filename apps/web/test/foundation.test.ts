import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies web", () => expect(packageName).toBe("web"));
