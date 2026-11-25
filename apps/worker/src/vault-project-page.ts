import type { Database } from "@litscout/db/database";
import { listVaultProjects } from "@litscout/db/vault-reads";

export async function vaultProjectPage(db: Database, after = "", id?: string) {
  // Each card can include ideas, referenced papers and historical radar.
  const size = 5;
  const rows = await listVaultProjects(db, after, id ? 1 : size + 1, id);
  return {
    items: rows.slice(0, size),
    next: rows.length > size ? rows[size - 1]!.id : null,
  };
}
