import { expect, it } from "vitest";
import { packageName } from "../src/index";
it("identifies mcp", () => expect(packageName).toBe("mcp"));
