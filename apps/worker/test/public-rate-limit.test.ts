import { expect, it } from "vitest";
import { backupCooldownOff, publicLimitOff } from "../src/auth/request-limit";

it("turns the public limiter off only for a local development Worker", () => {
  expect(publicLimitOff({})).toBe(false);
  expect(publicLimitOff({ PUBLIC_RATE_LIMIT: "off" })).toBe(false);
  expect(publicLimitOff({ LOCAL_DEV: "false", PUBLIC_RATE_LIMIT: "off" })).toBe(
    false,
  );
  expect(publicLimitOff({ LOCAL_DEV: "true", PUBLIC_RATE_LIMIT: "on" })).toBe(
    false,
  );
  expect(publicLimitOff({ LOCAL_DEV: "true", PUBLIC_RATE_LIMIT: "off" })).toBe(
    true,
  );
});

it("turns the export cooldown off only for a local development Worker", () => {
  expect(backupCooldownOff({})).toBe(false);
  expect(backupCooldownOff({ BACKUP_COOLDOWN: "off" })).toBe(false);
  expect(
    backupCooldownOff({ LOCAL_DEV: "false", BACKUP_COOLDOWN: "off" }),
  ).toBe(false);
  expect(backupCooldownOff({ LOCAL_DEV: "true", BACKUP_COOLDOWN: "off" })).toBe(
    true,
  );
});
