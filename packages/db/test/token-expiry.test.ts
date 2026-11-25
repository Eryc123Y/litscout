import { expect, it } from "vitest";
import { createApiToken, findApiToken, listApiTokens } from "../src/tokens";
import { databaseHarness } from "./harness";
for (const backend of ["sqlite", "d1"] as const)
  it(`rejects expired and revoked tokens, preserves optional expiry in ${backend}`, async () => {
    const { db, close } = await databaseHarness(backend);
    try {
      const hash = "c".repeat(64);
      const expiresAt = "2026-12-01T00:00:00.000Z";
      await createApiToken(db, {
        name: "expiring",
        hash,
        scopes: ["read"],
        expiresAt,
      });
      expect(
        await findApiToken(db, hash, "2026-11-30T23:59:59.000Z"),
      ).toMatchObject({ expiresAt });
      expect(await findApiToken(db, hash, expiresAt)).toBeNull();
      expect(
        await findApiToken(db, hash, "2026-12-02T00:00:00.000Z"),
      ).toBeNull();
      expect(await listApiTokens(db)).toMatchObject([{ expiresAt }]);
      const permanent = await createApiToken(db, {
        name: "permanent",
        hash: "d".repeat(64),
        scopes: ["read"],
      });
      expect(permanent.expiresAt).toBeNull();
      await expect(
        createApiToken(db, {
          name: "bad",
          hash: "e".repeat(64),
          scopes: ["read"],
          expiresAt: "invalid",
        }),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
