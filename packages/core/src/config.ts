import { z } from "zod";
import {
  agentModelSchema,
  agentApiSchema,
  agentCommandSchema,
  clientSchema,
  fallbackSchema,
} from "./agent-config";
import { digestSuggestionLimit, ingestLimitsSchema } from "./ingest-limits";
const count = z.number().int().min(0);
const strings = z.array(z.string().min(1));
/** One vault tag, or a list of tags that all mean the same note kind. */
const vaultTag = z.string().trim().min(1).max(100);
const vaultTags = z.union([vaultTag, z.array(vaultTag).min(1).max(20)]);
const tagKeys = (setting: string | readonly string[]) =>
  (typeof setting === "string" ? [setting] : setting).map((tag) =>
    tag.replace(/^#/, "").toLowerCase(),
  );
const kind = z.enum(["project", "soul", "brief", "plan", "other"]);
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "must be an IANA time zone");

export const teamDomainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i);
export const accessAudienceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
export const accessSchema = z.strictObject({
  teamDomain: teamDomainSchema.optional(),
  aud: accessAudienceSchema.optional(),
});
export const onTimeBySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const configuredTopicsSchema = z.array(
  z.strictObject({
    name: z.string().min(1),
    keywords: strings,
    color: z.string().optional(),
  }),
);
const webOrigin = z.url({ protocol: /^https?$/ }).refine((value) => {
  if (!/^https?:\/\/[^/\\@?#\s]+\/?$/i.test(value) || !URL.canParse(value))
    return false;
  const url = new URL(value);
  return !url.username && !url.password && url.href === `${url.origin}/`;
}, "Expected an HTTP(S) origin without credentials, a path, query or fragment");
export function httpsBrowserOrigin(value: string | undefined) {
  const result = webOrigin.safeParse(value);
  return result.success && new URL(result.data).protocol === "https:"
    ? result.data
    : undefined;
}
/** Whether a URL's hostname names the loopback interface: this computer. */
export function loopbackHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    (hostname.startsWith("127.") && z.ipv4().safeParse(hostname).success)
  );
}
const publicEndpoint = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const { protocol, hostname } = new URL(value);
  return (
    protocol === "https:" || (protocol === "http:" && loopbackHost(hostname))
  );
}, "Expected HTTPS or an HTTP loopback URL");
/** The origin the CLI may send tokens to: HTTPS, or HTTP on the loopback
 * interface (an own server checked before it has a public address). */
export function apiOrigin(value: string | undefined) {
  const result = publicEndpoint.safeParse(value);
  return result.success ? new URL(result.data).origin : undefined;
}
export const storageSchema = z
  .strictObject({
    fullDays: count.default(45),
    prune: z.boolean().default(true),
    pruneRowsPerDay: count.max(80_000).default(30_000),
    /** Compact rows expire this many months after the paper's last listing. */
    compactMonths: z.number().int().min(1).max(120).default(12),
  })
  .prefault({});
/** All fields and defaults from v0 §10; unknown fields are rejected. */
export const configSchema = z.strictObject({
  access: accessSchema.prefault({}),
  instance: z
    .strictObject({
      name: z.string().min(1).default("LitScout"),
      publicUrl: publicEndpoint.optional(),
      webUrl: webOrigin.optional(),
      timezone: timezone.default("UTC"),
      language: z.enum(["en", "zh"]).default("en"),
      publicFeed: z.boolean().default(false),
      limits: z
        .strictObject({ ingest: ingestLimitsSchema.prefault({}) })
        .prefault({}),
    })
    .prefault({})
    .transform((instance) => ({
      ...instance,
      webUrl: instance.webUrl ?? httpsBrowserOrigin(instance.publicUrl),
    })),
  sources: z
    .strictObject({
      crawlTimeoutSeconds: z.number().int().min(1).max(86400).default(1200),
      arxiv: z
        .strictObject({ categories: strings.default(["cs.CV", "cs.CL"]) })
        .prefault({}),
      huggingface: z
        .strictObject({
          dailyPapers: z.boolean().default(true),
          upvotesDays: count.default(7),
        })
        .prefault({}),
      venues: z
        .strictObject({
          watchlist: z.string().min(1).default("./venues.json"),
          kinds: z
            .array(z.enum(["journal", "conference"]))
            .default(["journal", "conference"]),
        })
        .prefault({}),
    })
    .prefault({}),
  topics: configuredTopicsSchema.default([]),
  schedule: z
    .strictObject({ onTimeBy: onTimeBySchema.default("11:30") })
    .prefault({}),
  profile: z
    .strictObject({
      root: z.string().min(1).default("./vault"),
      include: strings.default([]),
      exclude: strings.default(["**/NDA/**"]),
      kinds: z.record(z.string(), kind).default({}),
    })
    .prefault({}),
  vault: z
    .strictObject({
      root: z.string().min(1).default("./vault"),
      name: z.string().trim().min(1).max(255).optional(),
      write: z.boolean().default(false),
      projects: strings.default([]),
      exclude: strings.default(["**/.*", "**/*NDA*"]),
      uploadDescriptions: z.boolean().default(true),
      // Project, idea and working-paper bodies, so the web can show them
      // read-only. Off by default: note text otherwise stays on the Mac.
      uploadBodies: z.boolean().default(false),
      bodyExclude: strings.default([]),
      briefs: strings.default([]),
      ideaTag: vaultTags.default("type/idea"),
      workingPaperTag: vaultTags.default("type/working-paper"),
      // Where the Vault pages link for the vault conventions; without it
      // they name the section of docs/self-host.md.
      guideUrl: z
        .url({ protocol: /^https?$/ })
        .max(500)
        .optional(),
      inbox: z.string().min(1).default("Inbox.md"),
      paperNotes: z
        .strictObject({
          dirs: z.record(z.string().min(1), z.string().min(1)).default({}),
          template: z.string().min(1).optional(),
        })
        .prefault({}),
      digestsDir: z.string().min(1).default("LitScout/Digests"),
      digestTemplate: z.string().min(1).optional(),
    })
    .superRefine((vault, ctx) => {
      const ideas = new Set(tagKeys(vault.ideaTag));
      const shared = tagKeys(vault.workingPaperTag).filter((tag) =>
        ideas.has(tag),
      );
      if (shared.length)
        ctx.addIssue({
          code: "custom",
          path: ["workingPaperTag"],
          message:
            "A tag cannot be in both vault.ideaTag and vault.workingPaperTag: " +
            shared.join(", "),
        });
    })
    .prefault({}),
  library: z
    .strictObject({
      alphaxiv: z.boolean().default(true),
      /** The agent that captures the alphaXiv library for the nightly mirror
       * (`alphaxiv capture`): Claude Code with its claude.ai alphaXiv
       * connector, or none. */
      alphaxivCapture: z.enum(["none", "claude"]).default("none"),
      unpaywallEmail: z.email().max(254).optional(),
    })
    .prefault({}),
  digest: z
    .strictObject({
      picksPerTopic: count.default(3),
      radarFullTextPerDay: count.default(2),
      suggestionsPerDay: count.max(digestSuggestionLimit).default(3),
      ratingsLookbackDays: count.default(28),
      briefFiles: strings.default([]),
    })
    .prefault({}),
  research: z
    .strictObject({
      contextBodies: z.boolean().default(false),
      /**
       * Read projects and ideas for the digest from the instance's vault
       * index when the vault is not on this machine (an own server).
       */
      vaultIndex: z.boolean().default(false),
    })
    .prefault({}),
  storage: storageSchema,
  /** The approved legacy import, so the scheduled run can resume it. */
  legacy: z
    .strictObject({
      repo: z.string().min(1),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dir: z.string().min(1).optional(),
    })
    .refine(({ from, to }) => from <= to, {
      message: "legacy.from must not follow legacy.to",
    })
    .optional(),
  agent: z
    .strictObject({
      mode: z.enum(["client", "none"]).default("client"),
      api: agentApiSchema.optional(),
      summaries: z
        .strictObject({
          client: clientSchema.default("claude"),
          fallback: fallbackSchema,
          command: agentCommandSchema.optional(),
          model: agentModelSchema.optional(),
          parallel: count.min(1).max(8).default(2),
          chunkSize: count.min(1).max(100).default(40),
          maxChunks: count.default(20),
          // "tex" after cutover: the shadow run needs the old plain-text prompt.
          math: z.enum(["plain", "tex"]).default("plain"),
          usageFile: z.string().optional(),
          timeout: z.number().int().min(61).max(3600).default(900),
        })
        .prefault({}),
      digest: z
        .strictObject({
          client: clientSchema.default("claude"),
          fallback: fallbackSchema,
          model: agentModelSchema.optional(),
          command: agentCommandSchema.optional(),
          timeout: z.number().int().min(61).max(3600).default(900),
        })
        .prefault({}),
    })
    .prefault({}),
  mcp: z
    .strictObject({ researchTools: z.boolean().default(false) })
    .prefault({}),
});
export type LitScoutConfig = z.output<typeof configSchema>;

export type VaultTagSetting = LitScoutConfig["vault"]["ideaTag"];

/** Normalised tags: no leading #, lower case, each tag once, in order. */
export function vaultTagList(setting: VaultTagSetting): string[] {
  return [...new Set(tagKeys(setting))];
}

/** The setting as written, for display: one tag, or the list joined. */
export function vaultTagLabel(setting: VaultTagSetting): string {
  return typeof setting === "string" ? setting : setting.join(", ");
}
export type ConfigInput = z.input<typeof configSchema>;
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}
export function validateConfig(input: unknown): LitScoutConfig {
  const result = configSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ConfigValidationError(
    result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n"),
  );
}
export function defineConfig(input: ConfigInput): LitScoutConfig {
  return validateConfig(input);
}
