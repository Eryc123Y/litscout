import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const client = process.argv[2];
const args = process.argv.slice(3);

function block(prompt, name) {
  const content = prompt.match(new RegExp(`<${name}>\\n(.*)\\n</${name}>`));
  assert.ok(content, `Missing ${name} in digest prompt`);
  return JSON.parse(content[1]);
}

function digest(prompt) {
  const { candidates } = block(prompt, "paper-data");
  const { day, lang, topicCandidates } = block(prompt, "context-data");
  const { paperId, title } = candidates.find(
    ({ source }) => source === "arxiv",
  );
  const topic = topicCandidates.find(({ paperIds }) =>
    paperIds.includes(paperId),
  );
  const pick = { paperId, gist: title };
  return JSON.stringify({
    day,
    lang,
    topics: topic ? { [topic.name]: [pick] } : {},
    other: topic ? [] : [pick],
    reportText: `Fixture digest for ${day}. First paper: ${title}.`,
  });
}

function summaries(prompt) {
  // The summary writer's wire format is blocks. The CLI validates and uploads JSON.
  const papers = [
    ...prompt.matchAll(/^=== (\S+)\ntitle: (.+)\nabstract: (.+)$/gm),
  ];
  assert.ok(papers.length, "Summary prompt has no papers");
  return papers
    .map(
      ([, id, title, abstract]) =>
        `=== ${id}\ntldr: ${title}\nmotivation: Compare depth estimates.\nmethod: ${abstract}\nresult: The fixture reports a comparison.\nconclusion: This summary is based on the supplied abstract.`,
    )
    .join("\n");
}

function answer(prompt) {
  return prompt.startsWith("Write a LitScout daily digest.")
    ? digest(prompt)
    : summaries(prompt);
}

if (client === "codex" && args.join(" ") === "login status") {
  process.stdout.write("Logged in as a fixture\n");
} else if (client === "claude" && args.join(" ") === "auth status") {
  process.stdout.write('{"loggedIn":true}\n');
} else if (client === "codex") {
  const output = args.indexOf("-o");
  assert.ok(args[0] === "exec" && output >= 0 && args.at(-1) === "-");
  const prompt = readFileSync(0, "utf8");
  if (existsSync(path.join(process.env.HOME, "fail-codex"))) {
    process.stderr.write("Fixture quota exhausted\n");
    process.exitCode = 1;
  } else {
    writeFileSync(args[output + 1], answer(prompt));
  }
} else {
  // Claude Code reads its prompt on stdin, as the CLI sends it, and keeps
  // no session files.
  assert.ok(client === "claude" && args[0] === "-p" && args[1] === "--model");
  assert.ok(args.includes("--no-session-persistence"));
  const text = answer(readFileSync(0, "utf8"));
  const format = args.indexOf("--output-format");
  if (format >= 0 && args[format + 1] === "json") {
    // The digest asks for the JSON envelope with the draft checked against
    // its schema, as Claude Code returns it.
    assert.ok(JSON.parse(args[args.indexOf("--json-schema") + 1]).properties);
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: text,
        structured_output: JSON.parse(text),
      }) + "\n",
    );
  } else process.stdout.write(text + "\n");
}
