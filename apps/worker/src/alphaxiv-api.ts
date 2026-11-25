import { Hono, type Context } from "hono";
import {
  knownArxivQuery,
  mirrorPath,
  mirrorRun,
  mirrorStateQuery,
  mirrorWrite,
} from "@litscout/pipeline/alphaxiv-contracts";
import {
  beginAlphaXiv,
  finishAlphaXiv,
  knownArxivIds,
  readAlphaXiv,
  writeAlphaXiv,
} from "@litscout/db/alphaxiv";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";

export const alphaXivApi = new Hono<WorkerBindings>();
alphaXivApi.use(mirrorPath, requireDatabase);
alphaXivApi.use(mirrorPath + "/*", requireDatabase);
async function requireDatabase(
  c: Context<WorkerBindings>,
  next: () => Promise<void>,
) {
  c.header("Cache-Control", "no-store");
  if (!c.env.DB)
    return apiJson(
      c,
      {
        success: false,
        error: { code: "UNAVAILABLE", message: "Database unavailable" },
      },
      503,
    );
  await next();
}

alphaXivApi.get(mirrorPath, async (c) => {
  const { after } = mirrorStateQuery.parse(c.req.query());
  return apiJson(c, {
    success: true,
    data: await readAlphaXiv(c.env.DB!, after),
  });
});
alphaXivApi.get(mirrorPath + "/known", async (c) => {
  const ids = knownArxivQuery.parse(c.req.queries("id"));
  return apiJson(c, {
    success: true,
    data: await knownArxivIds(c.env.DB!, ids),
  });
});
for (const [suffix, action] of [
  ["/start", beginAlphaXiv],
  ["/finish", finishAlphaXiv],
] as const)
  alphaXivApi.post(mirrorPath + suffix, async (c) => {
    const { rowsWritten, ...data } = await action(
      c.env.DB!,
      mirrorRun.parse(c.get("ingestBody")),
    );
    return apiJson(c, { success: true, data, meta: { rowsWritten } });
  });
alphaXivApi.post(mirrorPath, async (c) => {
  const { rowsWritten, accepted } = await writeAlphaXiv(
    c.env.DB!,
    mirrorWrite.parse(c.get("ingestBody")),
  );
  return apiJson(c, {
    success: true,
    data: { accepted },
    meta: { rowsWritten },
  });
});
