import { expect, it } from "vitest";
import { checkClient } from "../src/agent-process";

it.each([
  [{ code: 1, stdout: "", stderr: "", spawnError: "ENOENT" }, "not found"],
  [{ code: 1, stdout: '{"loggedIn":false}', stderr: "" }, "not logged in"],
  [
    {
      code: 1,
      stdout: '{"loggedIn":false}',
      stderr: "The specified item could not be found in the keychain.",
    },
    "not logged in",
  ],
  [
    {
      code: 1,
      stdout: '{"loggedIn":false}',
      stderr: "security: User interaction is not allowed. (-25308)",
    },
    "Keychain unavailable",
  ],
  [{ code: 0, stdout: '{"loggedIn":true}', stderr: "" }, "ready"],
] as const)("classifies Claude preflight %j as %s", async (result, reason) => {
  await expect(checkClient("claude", async () => result)).resolves.toEqual({
    client: "claude",
    usable: reason === "ready",
    reason,
  });
});
