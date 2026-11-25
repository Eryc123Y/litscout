import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies sources", () => expect(packageName).toBe("sources"));
