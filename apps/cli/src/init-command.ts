import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defineConfig, type ConfigInput } from "@litscout/core";
import { UsageError, type SetupDeps } from "./command-types";
import { agentPreflight } from "./flow-runtime";
import {
  askSetup,
  configText,
  nextSteps,
  venuesText,
  type Answers,
} from "./init-wizard";
import { serverInit } from "./server-init";

const names = [
  "litscout.config.ts",
  "venues.json",
  "vault-paper-template.md",
  "vault-digest-template.md",
  "antigravity-sidecar.json",
  "claude-scheduled-task.md",
  "codex-exec.md",
  "cron.md",
];

export function initOptions(args: readonly string[], explicit?: string) {
  if (explicit || args.some((arg) => arg !== "--defaults"))
    throw new UsageError("Use init [--defaults] [--json]");
  return { defaults: args.includes("--defaults") };
}

/** The config the answers stand for, as `litscout server init` reads it. */
function settings(answers: Answers) {
  return defineConfig({
    instance: {
      ...(answers.publicUrl ? { publicUrl: answers.publicUrl } : {}),
      timezone: answers.timezone,
      language: answers.language,
    },
    sources: { arxiv: { categories: answers.categories } },
    topics: answers.topics,
    agent: answers.client
      ? {
          mode: "client",
          summaries: { client: answers.client, fallback: [] },
          digest: { client: answers.client, fallback: [] },
        }
      : { mode: "none" },
  } as ConfigInput);
}

async function writeAll(deps: SetupDeps, files: Map<string, string | Buffer>) {
  const created: string[] = [];
  try {
    for (const [name, content] of files) {
      const target = path.join(deps.cwd, name);
      await writeFile(target, content, { flag: "wx" });
      created.push(target);
    }
  } catch (error) {
    await Promise.all(created.map((file) => unlink(file)));
    throw error;
  }
}

/** `litscout init`: in a terminal, a few questions and a config written from
 * the answers (for a trial, the server's settings too); with --defaults,
 * --json or no terminal, the neutral starter files. Never overwrites. */
export async function initCommand(
  args: readonly string[],
  deps: SetupDeps,
  explicit?: string,
) {
  const { defaults } = initOptions(args, explicit);
  for (const name of names)
    if (
      await access(path.join(deps.cwd, name)).then(
        () => true,
        () => false,
      )
    )
      throw new UsageError(`Refusing to overwrite ${name}`);
  const template = (name: string) =>
    readFile(path.join(deps.templateDir, name));
  const files = new Map<string, string | Buffer>();
  if (defaults || deps.json || !deps.isTTY) {
    for (const name of names) files.set(name, await template(name));
    await writeAll(deps, files);
    return {
      data: {
        created: names,
        messages: [
          `Created: ${names.join(", ")}`,
          "Edit litscout.config.ts for categories, topics, language, agent mode and optional vault paths.",
          "Edit venues.json for venues and replace the placeholders in your chosen scheduler example.",
          "Follow docs/self-host.md for deployment and the first run.",
          ...(deps.isTTY && !deps.json
            ? []
            : [
                "In a terminal, `litscout init` asks a few questions and writes the config for you.",
              ]),
        ],
      },
    };
  }
  const answers = await askSetup({
    prompt: (label) => deps.prompt(label),
    print: deps.print,
    timeZone:
      deps.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    usable: async (client) =>
      (await agentPreflight(deps)(client)).usable === true,
    templateDir: deps.templateDir,
  });
  files.set(
    "litscout.config.ts",
    configText(answers, new Date().toISOString().slice(0, 10)),
  );
  files.set("venues.json", venuesText(answers.venues));
  for (const name of names.slice(2)) files.set(name, await template(name));
  await writeAll(deps, files);
  const config = path.join(deps.cwd, "litscout.config.ts");
  const base = path.join(deps.home ?? homedir(), "litscout");
  const serverJs = path.join(path.dirname(deps.templateDir), "server.js");
  const messages: string[] = [`Created: ${names.join(", ")}`];
  if (answers.where === "trial") {
    try {
      await serverInit(
        { base, local: true, force: false, dryRun: false },
        deps,
        settings(answers),
      );
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      messages.push(
        `The trial's settings were not written: ${error.message}`,
        "Fix that, then run `litscout server init --local` in this folder.",
      );
    }
  }
  messages.push(
    ...nextSteps(answers, {
      config,
      serverJson: path.join(base, "etc", "server.json"),
      serverJs,
    }),
  );
  return { data: { created: names, where: answers.where, messages } };
}
