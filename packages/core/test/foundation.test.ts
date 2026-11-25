import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies core", () => expect(packageName).toBe("core"));
