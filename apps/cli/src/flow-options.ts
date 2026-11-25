import { z } from "zod";
export function flowOptions(
  args: readonly string[],
  allowed: readonly string[],
) {
  const values: Record<string, string> = {},
    positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (!allowed.includes(key) || values[key] !== undefined)
      throw new Error(`Unknown or repeated option ${arg}`);
    if (
      [
        "dry-run",
        "final",
        "adopt",
        "yes",
        "force",
        "local",
        "accept-overlap",
        "over-cap",
        "import",
      ].includes(key)
    )
      values[key] = "true";
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);
      values[key] = value;
    }
  }
  return { values, positional };
}
export const integerOption = (
  value: string | undefined,
  fallback: number,
  max = 100,
) =>
  value === undefined
    ? fallback
    : z.coerce.number().int().min(0).max(max).parse(value);
