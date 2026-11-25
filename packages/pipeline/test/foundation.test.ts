import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies pipeline", () => expect(packageName).toBe("pipeline"));
