import { z } from "zod";
export const clientSchema = z.enum([
  "claude",
  "codex",
  "antigravity",
  "gemini",
  "cmd",
  "api",
]);
export type Client = z.output<typeof clientSchema>;
export const fallbackSchema = z
  .array(clientSchema)
  .max(5)
  .default(["codex", "antigravity"]);
export const agentModelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:-]+$/)
  .refine(
    (value) => !value.startsWith("-"),
    "Model must be a value, not an option",
  );
export const apiModelSchema = z
  .string()
  .max(128)
  .regex(/^[\w][\w./:-]*$/);

const apiCap = z.number().int().nonnegative();
const apiDefaults = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
} as const;
const blockedKeyPrefix =
  /^(?:LITSCOUT|CLOUDFLARE|CF|AWS|GITHUB|GH|GOOGLE|AZURE|NPM)_/i;
const dnsHostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const canonicalHost = (host: string) => host.toLowerCase().replace(/\.$/, "");
const publicHostname = (host: string) =>
  dnsHostname.test(host) &&
  !/\.[0-9]+$|\.(?:localhost|local|internal)$/.test(host);

export const agentApiSchema = z
  .strictObject({
    provider: z.enum(["anthropic", "openai"]),
    model: apiModelSchema.optional(),
    keyEnv: z
      .string()
      .max(96)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use an environment variable name")
      .refine(
        (name) =>
          /_(?:API_KEY|KEY)$/.test(name) && !blockedKeyPrefix.test(name),
        "Use a provider environment variable ending in _API_KEY or _KEY",
      ),
    baseUrl: z
      .url({ protocol: /^https$/ })
      .refine((value) => {
        const url = URL.parse(value);
        return (
          url &&
          !/[?#]/.test(value) &&
          !url.username &&
          !url.password &&
          publicHostname(canonicalHost(url.hostname))
        );
      }, "Use a public HTTPS hostname without credentials, query or fragment")
      .optional(),
    trustedHosts: z
      .array(
        z
          .string()
          .max(254)
          .transform(canonicalHost)
          .refine(
            publicHostname,
            "Use a public hostname without a scheme, port or path",
          ),
      )
      .max(100)
      .default([]),
    maxRequestsPerDay: apiCap,
    maxTokensPerDay: apiCap,
    maxRequestsPerRun: apiCap.optional(),
    maxTokensPerRun: apiCap.optional(),
    prices: z
      .strictObject({
        inputPerToken: z.number().nonnegative(),
        outputPerToken: z.number().nonnegative(),
      })
      .optional(),
  })
  .refine(({ provider, baseUrl }) => provider === "openai" || !baseUrl, {
    path: ["baseUrl"],
    message: "Only OpenAI-compatible providers can use a custom base URL",
  })
  .refine(
    ({ baseUrl, trustedHosts }) =>
      !baseUrl ||
      trustedHosts.includes(canonicalHost(new URL(baseUrl).hostname)),
    {
      path: ["baseUrl"],
      message: "Add this exact hostname to agent.api.trustedHosts",
    },
  )
  .refine(
    ({ maxRequestsPerRun, maxRequestsPerDay }) =>
      (maxRequestsPerRun ?? 0) <= maxRequestsPerDay,
    { path: ["maxRequestsPerRun"], message: "Must be within the daily cap" },
  )
  .refine(
    ({ maxTokensPerRun, maxTokensPerDay }) =>
      (maxTokensPerRun ?? 0) <= maxTokensPerDay,
    { path: ["maxTokensPerRun"], message: "Must be within the daily cap" },
  )
  .transform((api) => ({
    ...api,
    model: api.model ?? apiDefaults[api.provider],
  }));
export type AgentApiConfig = z.output<typeof agentApiSchema>;
const valueFlags = new Set([
  "--model",
  "-m",
  "--prompt",
  "-p",
  "--approval-mode",
  "--output-format",
  "--tools",
  "--mcp-config",
]);
/** Custom commands are trusted configuration; placeholders must stay argument values. */
export const agentCommandSchema = z
  .array(z.string().max(8192))
  .min(1)
  .max(100)
  .superRefine((args, ctx) => {
    if (!args[0] || args[0].startsWith("-"))
      ctx.addIssue({
        code: "custom",
        path: [0],
        message: "Command must name an executable",
      });
    for (const [i, arg] of args.entries())
      if (valueFlags.has(arg)) {
        const value = args[i + 1];
        if (
          value === undefined ||
          value.startsWith("-") ||
          (value === "" && arg !== "--tools")
        )
          ctx.addIssue({
            code: "custom",
            path: [i + 1],
            message: "Expected a command value, not an option",
          });
      }
  });
export function commandValues(
  template: readonly string[],
  prompt: string,
  model?: string,
) {
  const args = agentCommandSchema.parse(template);
  if (!args.some((p) => p.includes("{prompt}")))
    throw new Error("Client command must contain {prompt}");
  const values = args.map((part) => {
    const value = part
      .replaceAll("{prompt}", prompt)
      .replaceAll("{model}", model ?? "");
    if (
      (part.includes("{prompt}") || part.includes("{model}")) &&
      value.startsWith("-")
    )
      throw new Error("A command value must not start with '-'");
    return value;
  });
  for (const [i, arg] of values.entries())
    if (
      valueFlags.has(arg) &&
      (values[i + 1] === undefined ||
        values[i + 1]!.startsWith("-") ||
        (values[i + 1] === "" && arg !== "--tools"))
    )
      throw new Error("Expected a command value, not an option");
  return values;
}
