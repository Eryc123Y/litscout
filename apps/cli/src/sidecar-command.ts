import {
  chmod,
  readFile,
  writeFile,
  rename,
  rm,
  access,
  link,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { flowOptions } from "./flow-options";
import { secureDir } from "./state";
import {
  UsageError,
  type SetupDeps,
  type CommandResult,
} from "./command-types";
import { withSidecarLock } from "./sidecar-lock";
const sidecarSchema = z
  .object({
    args: z
      .array(z.string())
      .min(1)
      .refine(
        (args) => Boolean(args.at(-1)?.trim()),
        "Final args element must contain a prompt",
      ),
    agent_permissions: z
      .object({
        workspace_uris: z.array(z.string()).optional(),
        access_grants: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type Sidecar = z.output<typeof sidecarSchema>;
type Change = { path: string; value: string };
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
async function readSidecar(file: string) {
  const text = await readFile(file, "utf8");
  const parsed = sidecarSchema.safeParse(parseJson(text));
  if (!parsed.success)
    throw new UsageError(
      "Invalid sidecar: expected a nonempty string args array and workspace/grant arrays",
    );
  return { text, value: parsed.data };
}
function absolute(value: string, cwd: string, home: string) {
  const result = path.resolve(
    cwd,
    value.startsWith("~/") ? path.join(home, value.slice(2)) : value,
  );
  if (/[`\r\n]/.test(result))
    throw new UsageError(
      "Sidecar paths cannot contain backticks or line breaks",
    );
  return result;
}
function verifyChanges(
  before: Sidecar,
  after: Sidecar,
  changes: Change[] = [],
) {
  const expected: Record<string, unknown> = changes.length
    ? structuredClone(before)
    : before;
  for (const change of changes) {
    const keys = change.path.split(".");
    let current = expected;
    for (const [index, key] of keys.slice(0, -1).entries()) {
      current[key] ??= /^\d+$/.test(keys[index + 1]!) ? [] : {};
      current = current[key] as Record<string, unknown>;
    }
    current[keys.at(-1)!] = change.value;
  }
  if (!isDeepStrictEqual(sidecarSchema.parse(after), expected))
    throw new UsageError("Sidecar validation failed: unrelated values changed");
}
const dailyPointer = (repo: string, config: string, newOnly = false) => {
  const scope = newOnly
    ? " Run only LitScout. Skip Shadow mode and the completed legacy import."
    : "";
  return `Run LitScout for today by following \`${path.join(repo, "docs/runbook/daily.md")}\` exactly.${scope} Use \`--config ${config}\` wherever the runbook passes a config path. End with the report as the final message.`;
};

function requiredPermissions(repo: string, work: string) {
  return {
    workspace_uris: [pathToFileURL(repo).href],
    access_grants: [
      `read_file(${repo})`,
      "command(pnpm)",
      `read_file(${work})`,
      `write_file(${work})`,
    ],
  };
}

function plan(before: Sidecar, repo: string, config: string, work: string) {
  const value = structuredClone(before),
    changes: Change[] = [];
  const pointer = dailyPointer(repo, config);
  value.args[value.args.length - 1] = pointer;
  changes.push({ path: `args.${value.args.length - 1}`, value: pointer });
  value.agent_permissions ??= {};
  const required = requiredPermissions(repo, work);
  for (const key of ["workspace_uris", "access_grants"] as const) {
    const entries = (value.agent_permissions[key] ??= []);
    for (const entry of required[key])
      if (!entries.includes(entry)) {
        changes.push({
          path: `agent_permissions.${key}.${entries.length}`,
          value: entry,
        });
        entries.push(entry);
      }
  }
  verifyChanges(before, value, changes);
  return { value, changes };
}
async function atomicWrite(
  file: string,
  bytes: string | Buffer,
  { exclusive = false, mode = 0o600 } = {},
) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await chmod(temporary, mode);
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

// The pointer `sidecar shadow` installed before 2026-11-18 12:32 (6de8a4d).
// Antigravity still carries it, so cutover and restore must accept it.
const earlierDailyPointer = (repo: string, config: string) =>
  `Run LitScout for today by following \`${path.join(repo, "docs/runbook/daily.md")}\` exactly, passing \`--config ${config}\` to every litscout command. End with the report as the final message.`;

/** Where the Antigravity schedule keeps the LitScout task's sidecar. */
export const schedulerSidecar = (home: string) =>
  path.join(home, ".gemini/config/sidecars/litscout-daily/sidecar.json");

/**
 * Which mode the installed scheduler prompt is in, so `daily start` can say
 * it instead of leaving it to how a model reads the runbook. Only the final
 * prompt is compared with the pointer templates; nothing else is read out.
 */
export async function schedulerMode(home: string) {
  const file = schedulerSidecar(home);
  const text = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (text === null) return null;
  const parsed = sidecarSchema.safeParse(parseJson(text));
  if (!parsed.success) return { mode: "unknown" as const };
  if (shadowPointer(parsed.data))
    return {
      mode: "shadow" as const,
      oldPrompt: `litscout sidecar old-prompt --file ${path.join(path.dirname(file), "sidecar.before-m1b.json")}`,
    };
  const prompt = parsed.data.args.at(-1)!;
  const [, repo, config] =
    /following `([^\x60\r\n]+)\/docs\/runbook\/daily\.md` exactly\. Run only LitScout\. Skip Shadow mode and the completed legacy import\. Use `--config ([^\x60\r\n]+)`/.exec(
      prompt,
    ) ?? [];
  if (repo && config && prompt === dailyPointer(repo, config, true))
    return { mode: "cutover" as const };
  return { mode: "other" as const };
}

function shadowPointer(value: Sidecar) {
  const prompt = value.args.at(-1)!;
  const [, repo, config] =
    /following `([^\x60\r\n]+)\/docs\/runbook\/daily\.md` exactly(?:\. Use|, passing) `--config ([^\x60\r\n]+)`/.exec(
      prompt,
    ) ?? [];
  // Each wording must match its template exactly; nothing looser passes.
  return repo &&
    config &&
    path.isAbsolute(repo) &&
    path.isAbsolute(config) &&
    (prompt === dailyPointer(repo, config) ||
      prompt === earlierDailyPointer(repo, config))
    ? { repo, config, prompt }
    : null;
}

const timestampedBackup = (file: string, action: string, now: Date) =>
  `${file}.before-${action}-${now.toISOString().replaceAll(":", "-")}.json`;

async function saveBackup(file: string, bytes: string | Buffer) {
  try {
    await atomicWrite(file, bytes, { exclusive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new UsageError(
        `Sidecar backup already exists at ${file}; retry without overwriting it.`,
      );
    throw error;
  }
}

async function readLive(file: string) {
  return readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function replaceSidecar(
  file: string,
  before: string | Buffer | null,
  after: string,
  expected: Sidecar,
) {
  const mode = before === null ? 0o600 : (await stat(file)).mode & 0o7777;
  const live = await readLive(file);
  const previous = typeof before === "string" ? Buffer.from(before) : before;
  if (previous === null ? live !== null : !live?.equals(previous))
    throw new UsageError(
      "Sidecar changed during the update; pause the schedule and retry",
    );
  await atomicWrite(file, after, { mode });
  verifyChanges(expected, (await readSidecar(file)).value);
}

function planCutover(
  before: Sidecar,
  pointer: NonNullable<ReturnType<typeof shadowPointer>>,
  originalBackup: string,
  home: string,
  showKept = false,
) {
  const { repo, prompt } = pointer;
  const required = requiredPermissions(
    repo,
    path.join(home, ".cache/litscout/run"),
  );
  const oldRepo = path.join(home, "GitHub/litscout-daily");
  const oldUri = pathToFileURL(oldRepo).href;
  const exclusiveGrants = new Set([
    "command(uv)",
    "command(uvx)",
    "command(git)",
    "command(python)",
    "command(python3)",
  ]);
  const value = structuredClone(before);
  const nextPrompt = dailyPointer(repo, pointer.config, true);
  value.args[value.args.length - 1] = nextPrompt;
  const diff = [
    `- args[${value.args.length - 1}]: ${JSON.stringify(prompt)}`,
    `+ args[${value.args.length - 1}]: ${JSON.stringify(nextPrompt)}`,
  ];
  for (const key of ["workspace_uris", "access_grants"] as const) {
    const entries = value.agent_permissions?.[key] ?? [];
    if (!required[key].every((entry) => entries.includes(entry))) return null;
    value.agent_permissions![key] = entries.filter((entry) => {
      const target = /^(?:read_file|write_file)\((.*)\)$/.exec(entry)?.[1];
      const legacy =
        key === "workspace_uris"
          ? entry === oldUri || entry.startsWith(oldUri + "/")
          : exclusiveGrants.has(entry) ||
            target === originalBackup ||
            target === oldRepo ||
            target?.startsWith(oldRepo + "/");
      const keep = !legacy || required[key].includes(entry);
      if (showKept || !keep)
        diff.push(`${keep ? " " : "-"} ${key}: ${JSON.stringify(entry)}`);
      return keep;
    });
  }
  return { value, diff };
}

async function cutover(
  file: string,
  originalBackup: string,
  home: string,
  now: Date,
  dryRun: boolean,
): Promise<CommandResult> {
  const before = await readSidecar(file);
  const pointer = shadowPointer(before.value);
  if (!pointer)
    throw new UsageError(
      "Expected shadow mode: the final prompt must be the pointer installed by sidecar shadow.",
    );
  const original = await readSidecar(originalBackup).catch(() => {
    throw new UsageError(
      "Expected shadow mode: the original sidecar backup is missing or invalid.",
    );
  });
  if (shadowPointer(original.value))
    throw new UsageError(
      "Expected shadow mode: the original backup already points to the shadow runbook.",
    );
  const planned = planCutover(
    before.value,
    pointer,
    originalBackup,
    home,
    dryRun,
  );
  if (!planned)
    throw new UsageError(
      "Expected shadow mode: missing a required LitScout workspace or access grant.",
    );
  const { value, diff } = planned;
  const backup = timestampedBackup(file, "cutover", now);
  if (!dryRun) {
    await saveBackup(backup, before.text);
    await replaceSidecar(
      file,
      before.text,
      JSON.stringify(value, null, 2) + "\n",
      value,
    );
  }
  return {
    data: {
      status: dryRun ? "dry-run" : "updated",
      backup,
      diff,
      messages: [
        dryRun ? `Cutover preview for ${file}` : `Cutover applied to ${file}`,
        `${dryRun ? "Would back up to" : "Backup saved at"} ${backup}`,
        ...diff,
      ],
    },
  };
}

async function shadowBackupPath(file: string) {
  const prefix = path.basename(file) + ".before-cutover-";
  const latest = (await readdir(path.dirname(file)))
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/.test(
          name.slice(prefix.length),
        ),
    )
    .sort()
    .at(-1);
  return latest ? path.join(path.dirname(file), latest) : null;
}

function rollbackDiff(before: unknown, after: unknown, field = ""): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      rollbackDiff(
        Object.getOwnPropertyDescriptor(before, key)?.value,
        Object.getOwnPropertyDescriptor(after, key)?.value,
        Array.isArray(before)
          ? `${field}[${key}]`
          : field
            ? `${field}.${key}`
            : key,
      ),
    );
  }
  const location = field || "sidecar";
  return [
    ...(before === undefined
      ? []
      : [`- ${location}: ${JSON.stringify(before)}`]),
    ...(after === undefined ? [] : [`+ ${location}: ${JSON.stringify(after)}`]),
  ];
}

async function rollback(
  file: string,
  originalBackup: string,
  home: string,
  now: Date,
  { to, dryRun, force }: ReturnType<typeof sidecarOptions>,
): Promise<CommandResult> {
  const bytes = await readFile(file);
  const current = parseJson(bytes.toString("utf8"));
  const before = sidecarSchema.safeParse(current).data;
  const work = path.join(home, ".cache/litscout/run");
  const latest = await shadowBackupPath(file);
  const shadow = latest ? await readSidecar(latest).catch(() => null) : null;
  const shadowBackupPointer = shadow && shadowPointer(shadow.value);
  const original =
    to === "original" || !shadowBackupPointer
      ? await readSidecar(originalBackup).catch(() => null)
      : null;
  const livePointer = before && shadowPointer(before);
  const expectedShadow = shadowBackupPointer
    ? shadow?.value
    : livePointer && original && !shadowPointer(original.value)
      ? plan(original.value, livePointer.repo, livePointer.config, work).value
      : null;
  const isShadow = Boolean(
    expectedShadow && isDeepStrictEqual(before, expectedShadow),
  );
  if (to === "shadow" && isShadow) {
    return {
      data: {
        status: "unchanged",
        file,
        to,
        messages: [`Sidecar is already in shadow mode: ${file}`],
      },
    };
  }
  const backup = to === "shadow" ? latest : originalBackup;
  const saved = to === "shadow" ? shadow : original;
  if (!backup)
    throw new UsageError("No shadow backup exists for this sidecar.");
  if (!saved)
    throw new UsageError(`Cannot read a valid ${to} backup at ${backup}.`);
  if (Boolean(shadowPointer(saved.value)) !== (to === "shadow"))
    throw new UsageError(
      `Sidecar backup does not match the requested ${to} mode.`,
    );
  const plannedCutover =
    shadow &&
    shadowBackupPointer &&
    planCutover(shadow.value, shadowBackupPointer, originalBackup, home);
  const unexpectedShape =
    !isShadow &&
    (!plannedCutover || !isDeepStrictEqual(before, plannedCutover.value));
  const diff =
    dryRun || unexpectedShape ? rollbackDiff(current, saved.value) : undefined;
  if (unexpectedShape && !force) {
    const message =
      "Sidecar differs from the expected cutover and shadow modes. Review the rollback diff and pass --force to proceed.";
    return {
      failed: true,
      data: { message, diff, messages: [message, ...(diff ?? [])] },
    };
  }

  const safetyBackup = timestampedBackup(file, "rollback", now);
  if (!dryRun) {
    await saveBackup(safetyBackup, bytes);
    await replaceSidecar(file, bytes, saved.text, saved.value);
  }
  return {
    data: {
      status: dryRun ? "dry-run" : "restored",
      file,
      backup,
      safetyBackup,
      to,
      diff,
      messages: [
        `${dryRun ? "Would restore" : "Restored"} ${file} from ${backup}`,
        `${dryRun ? "Would back up to" : "Backup saved at"} ${safetyBackup}`,
        ...(diff ?? []),
      ],
    },
  };
}

export function sidecarOptions(args: readonly string[], explicit?: string) {
  const [command, ...rest] = args;
  const allowed = {
    shadow: ["file", "repo", "dry-run"],
    restore: ["file"],
    "old-prompt": ["file"],
    cutover: ["file", "dry-run"],
    rollback: ["file", "to", "dry-run", "force"],
  };
  if (!command || !Object.hasOwn(allowed, command))
    throw new UsageError(
      "Use sidecar shadow|cutover|rollback|restore|old-prompt --file PATH",
    );
  const mode = command as keyof typeof allowed;
  const { values, positional } = flowOptions(rest, allowed[mode]);
  if (positional.length || !values.file)
    throw new UsageError(`Use sidecar ${command} --file PATH`);
  if (
    command === "rollback" &&
    !["shadow", "original"].includes(values.to ?? "")
  )
    throw new UsageError(
      "Use sidecar rollback --file PATH --to shadow|original [--dry-run] [--force]",
    );
  if (command === "shadow" && !explicit)
    throw new UsageError("sidecar shadow requires --config CONFIG");
  if (command !== "shadow" && explicit)
    throw new UsageError("--config is only used by sidecar shadow");
  return {
    command: mode,
    file: values.file,
    repo: values.repo,
    dryRun: values["dry-run"] === "true",
    force: values.force === "true",
    to: values.to,
  };
}

export async function sidecarCommand(
  args: readonly string[],
  deps: SetupDeps,
  explicit?: string,
): Promise<CommandResult> {
  const options = sidecarOptions(args, explicit);
  const { command, dryRun } = options;
  const home = deps.env?.HOME ?? homedir(),
    file = absolute(options.file, deps.cwd, home);
  if (command === "old-prompt")
    return { data: (await readSidecar(file)).value.args.at(-1)! };
  const backup = path.join(path.dirname(file), "sidecar.before-m1b.json");
  const work = path.join(home, ".cache/litscout/run");
  const now = deps.flow?.now?.() ?? new Date();
  const apply = async () => {
    if (command === "cutover") return cutover(file, backup, home, now, dryRun);
    if (command === "rollback")
      return rollback(file, backup, home, now, options);
    return shadowOrRestore(file, backup, work, options, deps, home, explicit);
  };
  if (dryRun) return apply();
  return withSidecarLock(file + ".litscout.lock", now, apply);
}

async function shadowOrRestore(
  file: string,
  backup: string,
  work: string,
  options: ReturnType<typeof sidecarOptions>,
  deps: SetupDeps,
  home: string,
  explicit?: string,
) {
  const { command, dryRun } = options;
  if (command === "restore") {
    const original = await readSidecar(backup);
    await replaceSidecar(
      file,
      await readLive(file),
      original.text,
      original.value,
    );
    return { data: { restored: file, backup } };
  }
  if (
    await access(backup).then(
      () => true,
      () => false,
    )
  )
    throw new UsageError(
      "Sidecar backup already exists; refusing to overwrite it",
    );
  const original = await readSidecar(file),
    repo = absolute(options.repo ?? deps.cwd, deps.cwd, home),
    config = absolute(explicit!, deps.cwd, home);
  const planned = plan(original.value, repo, config, work);
  if (!dryRun) {
    await saveBackup(backup, original.text);
    verifyChanges(
      (await readSidecar(backup)).value,
      planned.value,
      planned.changes,
    );
    await secureDir(work);
    await replaceSidecar(
      file,
      original.text,
      JSON.stringify(planned.value, null, 2) + "\n",
      planned.value,
    );
  }
  return {
    data: {
      status: dryRun ? "dry-run" : "updated",
      backup,
      work,
      changes: planned.changes,
    },
  };
}
