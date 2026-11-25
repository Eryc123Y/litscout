import { retentionBatch } from "../src/retention";
import { countingDb } from "../test/helpers/counting-db";
import type { AppEnv } from "../src/env";
export { PairingStore } from "../src/auth/pairing-store";
export { SourceLimiter } from "@litscout/sources/limiter/source-limiter";

export default {
  async fetch(request: Request, env: AppEnv) {
    const size = Number(new URL(request.url).searchParams.get("size"));
    const measured = countingDb(env.DB!);
    const batch = await retentionBatch(
      { ...env, DB: measured.db },
      new Date(),
      {},
      false,
      size,
    );
    return Response.json({
      pruned: batch.papersPruned,
      charged: batch.rowsWritten,
      ...measured.stats(),
    });
  },
};
