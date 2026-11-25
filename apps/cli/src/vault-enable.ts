import type { LitScoutConfig } from "@litscout/core";
import { vaultPath, type SyncReport } from "@litscout/pipeline/vault-contracts";
import { openVault } from "@litscout/sync/vault-source";
import { checkDigestDirectory } from "@litscout/sync/vault-sink";
import { VaultError } from "@litscout/sync/vault-note";
import { BudgetStop } from "@litscout/pipeline/api";
import { QuotaExceeded } from "@litscout/pipeline/quota";
import { UsageError, type CommandResult } from "./command-types";
import { flowOptions } from "./flow-options";
import { flowApi, localDay, withFlowLock, type FlowDeps } from "./flow-runtime";
import { syncVault } from "./vault-sync";

export function enableWritesOptions(args: readonly string[]) {
  const { values, positional } = flowOptions(args, [
    "dry-run",
    "adopt",
    "digests-dir",
  ]);
  const digestsDir = values["digests-dir"];
  if (positional.length || !digestsDir)
    throw new UsageError(
      "Use vault enable-writes --digests-dir PATH [--adopt] [--dry-run]",
    );
  return {
    dryRun: values["dry-run"] === "true",
    adopt: values.adopt === "true",
    digestsDir: vaultPath.parse(digestsDir.replace(/\/+$/, "")),
  };
}

export async function previewVault(
  deps: FlowDeps,
  config: LitScoutConfig,
  options: { day?: string; adopt?: boolean; skipRequests?: boolean } = {},
) {
  return syncVault(
    config.vault,
    deps.configDir ?? deps.cwd,
    await flowApi(deps, config, { cacheBudget: false }),
    { day: localDay(deps, config), ...options, dryRun: true },
  );
}

export function previewProblems({ issues, handEdited }: SyncReport) {
  return [
    ...issues.map(({ path, reason }) => path + " · " + reason),
    ...handEdited.map((path) => "Hand-edited block kept · " + path),
  ];
}

export async function enableWrites(
  options: ReturnType<typeof enableWritesOptions>,
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const current = config.vault.digestsDir.replace(/\/+$/, "");
  const { adopt, dryRun, digestsDir } = options;
  const day = localDay(deps, config);
  const configDir = deps.configDir ?? deps.cwd;
  const configEdit = { write: true, digestsDir } as const;
  const target = { ...config, vault: { ...config.vault, ...configEdit } };
  const edit = `Set in the vault config: write: true, digestsDir: ${JSON.stringify(digestsDir)}`;
  const writes: SyncReport["writes"] = [];
  const rejected = (stage: string, problems: string[]): CommandResult => ({
    failed: true,
    data: {
      stage,
      problems,
      writes,
      messages: [
        stage,
        ...problems,
        ...writes.map(({ kind, path }) => `applied ${kind} · ${path}`),
      ],
    },
  });
  const work = async (): Promise<CommandResult> => {
    let stage = "Current sync preview failed";
    try {
      const previewOptions = { day, adopt: current === digestsDir && adopt };
      const problems = previewProblems(
        await previewVault(deps, config, previewOptions),
      );
      if (problems.length) return rejected(stage, problems);

      stage = "Digest folder check failed";
      const vault = await openVault(target.vault, configDir);
      await checkDigestDirectory(vault, digestsDir, adopt);

      stage = "Target sync preview failed";
      const preview = await previewVault(deps, target, {
        day,
        adopt,
        skipRequests: true,
      });
      const targetProblems = previewProblems(preview);
      if (targetProblems.length) return rejected(stage, targetProblems);

      stage = "First vault sync failed";
      const result = dryRun
        ? preview
        : await syncVault(
            target.vault,
            configDir,
            await flowApi(deps, target),
            {
              day,
              adopt,
              skipRequests: true,
              onWrite: (write) => writes.push(write),
            },
          );
      const syncProblems = previewProblems(result);
      if (syncProblems.length) return rejected(stage, syncProblems);
      return {
        data: {
          ...result,
          configEdit,
          messages: [
            edit,
            result.summary,
            ...result.writes.map(
              ({ mode, kind, path }) => `${mode} ${kind} · ${path}`,
            ),
            "Queued vault requests wait for a later normal sync.",
          ],
        },
      };
    } catch (error) {
      const reason =
        error instanceof VaultError
          ? error.message
          : error instanceof BudgetStop || error instanceof QuotaExceeded
            ? "Write budget reached. Retry after " + error.resumeAt + "."
            : "Check the vault, scheduler credentials and Worker availability before retrying.";
      return rejected(stage, [reason]);
    }
  };
  return dryRun ? work() : withFlowLock(deps, work);
}
