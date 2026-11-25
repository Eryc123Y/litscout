import { z } from "zod";
import { estimateSize } from "./size-model";
import { selectedVariant } from "./fts-variants";
const count = z.coerce
  .number()
  .int()
  .min(1)
  .max(100_000)
  .parse(process.argv[2] ?? 1000);
const d1 = process.argv.slice(3).includes("--d1");
const options = process.argv.slice(3).filter((option) => option !== "--d1");
if (options.length && (options.length !== 2 || options[0] !== "--variant"))
  throw new Error("Use N [--variant compact|lean] [--d1]");
const variant = z
  .enum(["compact", "lean"])
  .parse(options[1] ?? selectedVariant());
process.stdout.write(
  JSON.stringify(
    {
      ...estimateSize(count, variant),
      ...(d1
        ? {
            localD1: await (
              await import("./write-cost")
            ).measureWriteCosts(count),
          }
        : {}),
    },
    null,
    2,
  ) + "\n",
);
