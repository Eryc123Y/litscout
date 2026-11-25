import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies db", () => expect(packageName).toBe("db"));
