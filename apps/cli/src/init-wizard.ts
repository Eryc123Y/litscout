import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@litscout/core";

/** The questions `litscout init` asks in a terminal, and the files written
 * from the answers. Every question has a default or says what to type, and
 * an answer that cannot be used is asked again. */

export type Where = "trial" | "cloudflare" | "server";
export type Topic = { name: string; keywords: string[] };
export type Venue = Record<string, unknown> & { name: string };
export type Answers = {
  where: Where;
  publicUrl?: string;
  timezone: string;
  language: "en" | "zh";
  categories: string[];
  topics: Topic[];
  client: Client | null;
  venues: Venue[];
};
export type WizardDeps = {
  prompt: (label: string) => Promise<string>;
  print: (text: string) => void;
  /** The time zone this computer is set to. */
  timeZone: () => string;
  /** Whether an agent CLI is installed and signed in. */
  usable: (client: Client) => Promise<boolean>;
  templateDir: string;
};

const trialUrl = "http://127.0.0.1:8787";
const categories: [string, string][] = [
  ["cs.AI", "Artificial intelligence"],
  ["cs.CL", "Computation and language"],
  ["cs.CV", "Computer vision and pattern recognition"],
  ["cs.LG", "Machine learning"],
  ["stat.ML", "Machine learning (statistics)"],
  ["cs.RO", "Robotics"],
  ["cs.IR", "Information retrieval"],
  ["cs.HC", "Human-computer interaction"],
  ["cs.GR", "Graphics"],
  ["cs.SD", "Sound"],
  ["eess.AS", "Audio and speech processing"],
  ["eess.IV", "Image and video processing"],
  ["cs.CR", "Cryptography and security"],
  ["cs.SE", "Software engineering"],
  ["cs.DC", "Distributed and parallel computing"],
  ["cs.LO", "Logic in computer science"],
  ["cs.NE", "Neural and evolutionary computing"],
  ["cs.MA", "Multiagent systems"],
  ["math.OC", "Optimization and control"],
  ["q-bio.NC", "Neurons and cognition"],
];
const clientNames: [Client, string][] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["antigravity", "Antigravity"],
];

const validZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
const list = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Ask until `read` accepts the answer; it returns undefined to ask again. */
async function ask<T>(
  deps: WizardDeps,
  label: string,
  read: (answer: string) => T | undefined,
  again: string,
): Promise<T> {
  for (;;) {
    const value = read((await deps.prompt(label)).trim());
    if (value !== undefined) return value;
    deps.print(again);
  }
}
const numbered = (lines: string[]) =>
  lines.map((line, index) => `  ${String(index + 1).padStart(2)}. ${line}`);

async function where(deps: WizardDeps) {
  deps.print(
    [
      "",
      "How will you run LitScout?",
      ...numbered([
        "Try it on this computer: no account, no server, no sign-in",
        "On Cloudflare: a Worker and a D1 database (needs a Cloudflare account)",
        "On your own Linux server",
      ]),
    ].join("\n"),
  );
  return ask<Where>(
    deps,
    "Choice [1]",
    (answer) =>
      (
        ({
          "": "trial",
          "1": "trial",
          "2": "cloudflare",
          "3": "server",
        }) as const
      )[answer as "" | "1" | "2" | "3"],
    "Type 1, 2 or 3.",
  );
}

async function categoryList(deps: WizardDeps) {
  deps.print(
    [
      "",
      "Which arXiv categories should LitScout read each day? Type numbers from",
      "this list or category codes (any arXiv code works), separated by commas.",
      ...numbered(categories.map(([code, name]) => `${code.padEnd(9)}${name}`)),
    ].join("\n"),
  );
  return ask(
    deps,
    "Categories, for example 3, 4 or cs.CV",
    (answer) => {
      const picked = list(answer).map((item) =>
        /^\d+$/.test(item) ? categories[Number(item) - 1]?.[0] : item,
      );
      return picked.length &&
        picked.every((code) => code && /^[a-z-]+(\.[A-Za-z-]+)?$/.test(code))
        ? [...new Set(picked as string[])]
        : undefined;
    },
    "Pick at least one category: a number from the list or a code such as cs.LG.",
  );
}

async function topics(deps: WizardDeps) {
  deps.print(
    [
      "",
      "Topics sort each day's papers. A paper whose title or abstract contains",
      "one of a topic's keywords goes under that topic and on the day's",
      "shortlist. Name a topic, then give a few keywords or phrases.",
    ].join("\n"),
  );
  const chosen: Topic[] = [];
  for (;;) {
    const first = chosen.length === 0;
    const name = await ask(
      deps,
      first
        ? "Topic 1 name"
        : `Topic ${chosen.length + 1} name (Enter to finish)`,
      (answer) =>
        answer
          ? chosen.some((t) => t.name === answer)
            ? undefined
            : answer
          : first
            ? undefined
            : "",
      first
        ? "Name at least one topic, for example Depth estimation."
        : "You already have that topic; name another or press Enter.",
    );
    if (!name) return chosen;
    const keywords = await ask(
      deps,
      `Keywords for "${name}", separated by commas`,
      (answer) => (list(answer).length ? list(answer) : undefined),
      "Give at least one keyword or phrase.",
    );
    chosen.push({ name, keywords });
  }
}

async function agentClient(deps: WizardDeps): Promise<Client | null> {
  deps.print(
    [
      "",
      "Summaries and a morning brief are written by an agent CLI you are",
      "signed in to. Looking for Claude Code, Codex and Antigravity...",
    ].join("\n"),
  );
  const found: [Client, string][] = [];
  for (const entry of clientNames)
    if (await deps.usable(entry[0]).catch(() => false)) found.push(entry);
  if (!found.length) {
    deps.print(
      [
        "None is signed in on this computer, so LitScout runs in keyword mode:",
        "the matches come first, with their abstracts. To add summaries later,",
        'sign in to one and set agent.mode to "client" in litscout.config.ts.',
      ].join("\n"),
    );
    return null;
  }
  if (found.length === 1) {
    const [client, name] = found[0]!;
    return ask(
      deps,
      `Use ${name} to write them? [Y/n]`,
      (answer) =>
        /^(|y|yes)$/i.test(answer)
          ? client
          : /^(n|no)$/i.test(answer)
            ? null
            : undefined,
      "Type y or n.",
    );
  }
  deps.print(
    [
      "Write them with:",
      ...numbered([...found.map(([, n]) => n), "None"]),
    ].join("\n"),
  );
  return ask(
    deps,
    "Choice [1]",
    (answer) => {
      const index = answer ? Number(answer) - 1 : 0;
      if (index === found.length) return null;
      return found[index]?.[0];
    },
    `Type a number from 1 to ${found.length + 1}.`,
  );
}

async function venues(deps: WizardDeps) {
  const catalog = JSON.parse(
    await readFile(path.join(deps.templateDir, "venue-catalog.json"), "utf8"),
  ) as { areas: { name: string; venues: Venue[] }[] };
  deps.print(
    [
      "",
      "LitScout can also watch journals and conferences beside arXiv. Pick",
      "areas by number, or press Enter for none; venues.json can be edited",
      "later.",
      ...numbered(
        catalog.areas.map(
          (area) =>
            `${area.name} (${area.venues
              .slice(0, 4)
              .map((v) => v.name)
              .join(", ")}${area.venues.length > 4 ? ", ..." : ""})`,
        ),
      ),
    ].join("\n"),
  );
  return ask(
    deps,
    "Areas, for example 1, 2",
    (answer) => {
      const picked = list(answer).map((item) =>
        /^\d+$/.test(item) ? catalog.areas[Number(item) - 1] : undefined,
      );
      return picked.every(Boolean)
        ? picked.flatMap((area) => area!.venues)
        : undefined;
    },
    `Type numbers from 1 to ${catalog.areas.length}, or press Enter.`,
  );
}

export async function askSetup(deps: WizardDeps): Promise<Answers> {
  deps.print(
    "LitScout setup. Press Enter to take the suggestion in [brackets].",
  );
  const place = await where(deps);
  const publicUrl =
    place === "trial"
      ? trialUrl
      : place === "server"
        ? await ask(
            deps,
            "The server's public https address (Enter to set it later)",
            (answer) =>
              !answer
                ? ""
                : /^https:\/\/[^/\s]+\/?$/.test(answer)
                  ? answer.replace(/\/$/, "")
                  : undefined,
            "Type an address such as https://litscout.example.org, or press Enter.",
          )
        : "";
  const detected = deps.timeZone();
  const timezone = await ask(
    deps,
    `\nTime zone [${detected}]`,
    (answer) => {
      const value = answer || detected;
      return validZone(value) ? value : undefined;
    },
    "Type an IANA time zone, such as Europe/Berlin or Asia/Tokyo.",
  );
  const language = await ask<"en" | "zh">(
    deps,
    "Language for summaries and the morning brief, en or zh [en]",
    (answer) =>
      answer === "" || answer === "en"
        ? "en"
        : answer === "zh"
          ? "zh"
          : undefined,
    "Type en or zh.",
  );
  return {
    where: place,
    ...(publicUrl ? { publicUrl } : {}),
    timezone,
    language,
    categories: await categoryList(deps),
    topics: await topics(deps),
    client: await agentClient(deps),
    venues: await venues(deps),
  };
}

const quote = (value: string) => JSON.stringify(value);
const quoteAll = (values: string[]) => `[${values.map(quote).join(", ")}]`;

/** litscout.config.ts for the answers, with the optional parts as comments. */
export function configText(answers: Answers, today: string) {
  const agent = answers.client
    ? [
        "  agent: {",
        '    mode: "client",',
        `    summaries: { client: ${quote(answers.client)}, fallback: [] },`,
        `    digest: { client: ${quote(answers.client)}, fallback: [] },`,
        "  },",
      ]
    : [
        "  agent: {",
        "    // Keyword mode: matches first, with their abstracts. For summaries",
        '    // and a morning brief, set mode to "client" and name a signed-in',
        '    // agent CLI, for example summaries: { client: "claude", fallback: [] }.',
        '    mode: "none",',
        "  },",
      ];
  const address =
    answers.where === "trial"
      ? `    publicUrl: ${quote(trialUrl)}, // a trial on this computer`
      : answers.publicUrl
        ? `    publicUrl: ${quote(answers.publicUrl)},`
        : answers.where === "cloudflare"
          ? "    // publicUrl is recorded by `litscout deploy`."
          : '    // publicUrl: "https://litscout.example.org", // the server\'s public address';
  return [
    'import { defineConfig } from "@litscout/core";',
    "",
    `// Written by \`litscout init\` on ${today}. Change anything here; the guides`,
    "// describe every setting (docs/self-host.md, docs/try-locally.md).",
    "export default defineConfig({",
    "  instance: {",
    '    name: "LitScout",',
    address,
    `    timezone: ${quote(answers.timezone)},`,
    `    language: ${quote(answers.language)},`,
    "    // Opt in explicitly to publish paper feeds and topic names.",
    "    publicFeed: false,",
    "  },",
    ...(answers.where === "cloudflare"
      ? [
          "  access: {",
          "    // Set both from the private browser application in Cloudflare Access.",
          '    // teamDomain: "your-team.cloudflareaccess.com",',
          '    // aud: "YOUR_ACCESS_AUD",',
          "  },",
        ]
      : []),
    "  sources: {",
    `    arxiv: { categories: ${quoteAll(answers.categories)} },`,
    '    venues: { watchlist: "./venues.json" },',
    "  },",
    "  // A keyword in a paper's title or abstract puts it under that topic.",
    "  topics: [",
    ...answers.topics.map(
      (topic) =>
        `    { name: ${quote(topic.name)}, keywords: ${quoteAll(topic.keywords)} },`,
    ),
    "  ],",
    ...agent,
    "  // Obsidian vault sync is off. To turn it on, see",
    "  // docs/self-host.md#obsidian-vault-sync.",
    "});",
    "",
  ].join("\n");
}

export const venuesText = (chosen: Venue[]) =>
  JSON.stringify({ venues: chosen }, null, 2) + "\n";

/** What to do next, for the place the reader chose. */
export function nextSteps(
  answers: Answers,
  paths: { config: string; serverJson?: string; serverJs: string },
) {
  if (answers.where === "trial")
    return [
      `Your answers are in ${paths.config}.`,
      "Next:",
      "  1. Start LitScout and leave it running in this terminal:",
      `     node ${paths.serverJs} serve --config ${paths.serverJson}`,
      `  2. In a second terminal, in ${path.dirname(paths.config)}:`,
      "     litscout token create --name scheduler --scopes read,ingest --save-only",
      "     litscout daily fetch --json",
      `  3. Open ${trialUrl}/app/days and pick the day the fetch reported.`,
      "To change your answers later, edit litscout.config.ts, run",
      "`litscout server init --local --force` and restart the server.",
    ];
  return [
    `Your answers are in ${paths.config}.`,
    answers.where === "cloudflare"
      ? "Next: follow docs/self-host.md from step 3, Sign in to Wrangler."
      : "Next: follow docs/self-host-server.md from step 5, at `litscout server init`.",
  ];
}
