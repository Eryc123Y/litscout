import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { validateConfig, type LitScoutConfig } from "@litscout/core";
import { openVault, localVaultSource } from "../src/vault-source";
import { localVaultSink } from "../src/vault-sink";
import { hash, parseNote } from "../src/vault-note";

let tmp: string;
let root: string;
let config: LitScoutConfig["vault"];
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "litscout-vault-"));
  root = await mkdir(path.join(tmp, "vault")).then(() =>
    path.join(tmp, "vault"),
  );
  config = validateConfig({
    vault: {
      root,
      projects: ["Projects/*.md"],
      exclude: ["Private", "**/Secret*.md"],
      paperNotes: { dirs: { Stereo: "Papers" } },
    },
  }).vault;
});
afterEach(() => rm(tmp, { recursive: true, force: true }));
async function note(file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
const rawIdea =
  "\uFEFF---\r\n# keep\r\ntags: '#type/idea #example'\r\nstatus: 'seed'  # keep too\r\npapers: [ '2406.09414' ] # ordered\r\nprivate: \"format me never\"\r\n---\r\n\r\nPRIVATE IDEA BODY\r\n";
const paper = {
  id: "pap_test",
  title: "A stereo paper",
  arxiv: "2406.09415",
  topics: ["Stereo"],
  links: [],
  notes: ["A quick note"],
};

it("indexes only allowed frontmatter, body hashes and relative paths", async () => {
  expect(config.write).toBe(false);
  await note("Ideas/First.md", rawIdea);
  await note(
    "Projects/Stereo.md",
    "---\ntitle: Stereo\ndescription: Short\n---\nPRIVATE PROJECT BODY",
  );
  await note(
    "Papers/Paper.md",
    "---\ntags: [type/paper, '#topic/stereo']\nmaturity: understood\narxiv: 2406.09415\n---\nPRIVATE PAPER BODY",
  );
  await note(
    "Outline.md",
    "---\ntags: [type/working-paper]\nideas: ['[[Ideas/First]]']\n---\nPRIVATE OUTLINE",
  );
  await note("Private/Hide.md", rawIdea);
  await note("Ideas/Secret plan.md", rawIdea);
  await writeFile(path.join(tmp, "Outside.md"), rawIdea);
  await symlink(
    path.join(tmp, "Outside.md"),
    path.join(root, "Ideas/Symlink.md"),
  );
  await symlink(tmp, path.join(root, "Escape"));
  const { notes: rows } = await localVaultSource(
    await openVault(config),
    config,
  ).index();
  expect(rows.map(({ path, kind }) => [path, kind])).toEqual([
    ["Ideas/First.md", "idea"],
    ["Outline.md", "working_paper"],
    ["Papers/Paper.md", "paper_note"],
    ["Projects/Stereo.md", "project"],
  ]);
  expect(rows[0]).toMatchObject({
    id: hash("Ideas/First.md"),
    hash: hash(rawIdea),
    bodyHash: hash("\r\nPRIVATE IDEA BODY\r\n"),
    title: "First",
    frontmatter: { status: "seed", papers: ["2406.09414"] },
  });
  expect(JSON.stringify(rows)).not.toMatch(
    /PRIVATE|private|Escape|Symlink|Secret/,
  );
});

it("uploads project, idea and draft bodies only when asked, and never paper notes or excluded ones", async () => {
  // 2026-11-20: read these notes on the web. Off unless configured.
  const withBodies = validateConfig({
    vault: {
      root,
      projects: ["Projects/*.md"],
      exclude: ["Private"],
      uploadBodies: true,
      bodyExclude: ["Projects/Partner*.md"],
    },
  }).vault;
  await note("Ideas/First.md", rawIdea);
  await note(
    "Projects/Stereo.md",
    "---\ntitle: Stereo\n---\n# Plan\n\nShared body %%private aside%%\n<!-- hidden -->\n%%\nblock\n%%\nEnd\n",
  );
  await note("Projects/Partner deal.md", "---\ntitle: Partner\n---\nNDA BODY");
  await note(
    "Projects/Long.md",
    "---\ntitle: Long\n---\n" + "x".repeat(32_001),
  );
  await note(
    "Papers/Paper.md",
    "---\ntags: [type/paper]\narxiv: 2406.09415\n---\nPAPER BODY",
  );
  await note("Outline.md", "---\ntags: [type/working-paper]\n---\nDraft body");
  const { notes: rows } = await localVaultSource(
    await openVault(withBodies),
    withBodies,
  ).index();
  const body = (file: string) =>
    (rows.find((row) => row.path === file) as { body?: string } | undefined)
      ?.body;
  // Obsidian and HTML comments are hidden in reading view and stay local.
  expect(body("Projects/Stereo.md")).toBe("# Plan\n\nShared body \n\n\nEnd");
  expect(body("Ideas/First.md")).toBe("PRIVATE IDEA BODY");
  expect(body("Outline.md")).toBe("Draft body");
  expect(body("Papers/Paper.md")).toBeUndefined();
  expect(body("Projects/Partner deal.md")).toBeUndefined();
  // A long body is cut with a pointer to the rest.
  expect(body("Projects/Long.md")).toMatch(
    /^x{31900,}\n\n\*Continues in the vault\.\*$/,
  );
  expect(body("Projects/Long.md")!.length).toBeLessThanOrEqual(32_000);
  expect(JSON.stringify(rows)).not.toMatch(/NDA BODY|PAPER BODY/);
  // The default stays as before: no body leaves the Mac. Turning bodies off
  // changes the uploaded note, so the next sync replaces it and clears them.
  expect(config.uploadBodies).toBe(false);
  const { notes: plain } = await localVaultSource(
    await openVault({ ...withBodies, uploadBodies: false }),
    { ...withBodies, uploadBodies: false },
  ).index();
  const stereo = (list: typeof rows) =>
    JSON.stringify(list.find((row) => row.path === "Projects/Stereo.md"));
  expect(stereo(plain)).not.toBe(stereo(rows));
  expect(stereo(plain)).not.toContain("Shared body");
});

it("skips template notes with Templater or core placeholders and counts them", async () => {
  await note(
    "System/Templates/Literature Note.md",
    '---\ndate: <% tp.date.now("YYYY-MM-DD") %>\ntags: [type/paper]\n---\n# <% tp.file.title %>\n',
  );
  await note(
    "System/Templates/paper-note.md",
    "---\ntags: [type/paper]\ndate_created: {{date}}\n---\n",
  );
  await note(
    "System/Templates/Titled.md",
    '---\ntitle: "{{title}}"\ntags: [type/paper]\ndoi: 10.1000/template\n---\n',
  );
  // Braces in the body are prose, not a template.
  await note(
    "Papers/Real.md",
    "---\ntags: [type/paper]\narxiv: 2611.00001\n---\nUses {{handlebars}} and <% tags %> in text.\n",
  );
  // Real frontmatter that only looks like placeholders.
  await note(
    "Papers/BERT.md",
    '---\ntitle: "{{BERT}}: Pre-training of Deep Bidirectional Transformers"\ntags: [type/paper]\narxiv: 1810.04805\n---\n',
  );
  await note(
    "Papers/Frac.md",
    '---\ntitle: "Bounds for $\\frac{{a}}{b}$"\ntags: [type/paper]\ndoi: 10.1000/frac\n---\n',
  );
  await note(
    "Papers/Lines.md",
    '---\ntags: [type/paper]\narxiv: 2611.00002\nnote: "a <% b"\nother: "c %> d"\n---\n',
  );
  // A template whose placeholders make the YAML invalid is still a template.
  await note(
    "System/Templates/Broken.md",
    "---\ntags: [type/paper]\ntitle: <% tp.file.title %>\nlinks: [\n---\n",
  );
  // A private template stays private and unnamed.
  await note(
    "System/Templates/Private.md",
    "---\nlitscout: private\ndate: {{date}}\ntags: [type/paper]\n---\n",
  );
  // A note under the project paths is a project, whatever its frontmatter holds.
  await note(
    "Projects/Live.md",
    "---\ntype: project\nupdated: {{date:YYYY-MM-DD}}\n---\n",
  );
  const scan = await localVaultSource(await openVault(config), config).index();
  expect(scan.notes.map(({ kind, path }) => [kind, path])).toEqual([
    ["paper_note", "Papers/BERT.md"],
    ["paper_note", "Papers/Frac.md"],
    ["paper_note", "Papers/Lines.md"],
    ["paper_note", "Papers/Real.md"],
    ["project", "Projects/Live.md"],
  ]);
  expect(scan.conventions?.templates).toEqual({
    count: 4,
    paths: [
      "System/Templates/Broken.md",
      "System/Templates/Literature Note.md",
      "System/Templates/Titled.md",
      "System/Templates/paper-note.md",
    ],
  });
  expect(scan.conventions?.privateNotes).toBe(1);
  expect(scan.issues ?? []).toEqual([]);
  // Templates are not counted as paper notes missing identifiers.
  expect(scan.conventions?.paperNotesWithoutIdentifiers.count).toBe(0);
});

it("reports conventions for visible notes and counts excluded and private notes without naming them", async () => {
  const settings = {
    ...config,
    ideaTag: "#lab/idea",
    workingPaperTag: "lab/draft",
  };
  await note("Projects/Typed.md", "---\ntype: Project\n---\n");
  await note("Projects/Tagged.md", "---\ntags: [type/project]\n---\n");
  await note(
    "Projects/Reference.md",
    "---\ntype: reference\ntags: [lab/idea, lab/draft]\n---\n",
  );
  await note("Private/Nested/Hidden fixture.md", rawIdea);
  await note("Private/data.txt", "Ignored");
  await note("Secret fixture.md", rawIdea);
  await symlink(tmp, path.join(root, "Private", "Escape"));
  await note("Invisible fixture.md", "---\nlitscout: ' Private '\n---\n");
  await note(
    "Projects/Invisible project.md",
    "---\nlitscout: private\ntags: [lab/idea, lab/draft, type/paper]\n---\n",
  );
  await note(
    "Paper with ID.md",
    "---\ntags: [type/paper]\ndoi: 10.1000/example\n---\n",
  );
  const paths = Array.from(
    { length: 52 },
    (_, i) => "Papers/" + (100 + i) + ".md",
  );
  for (const file of paths)
    await note(file, "---\ntags: [type/paper]\narxiv: \n---\n");

  const scan = await localVaultSource(
    await openVault(settings),
    settings,
  ).index();
  expect(scan.conventions).toEqual({
    ideaTag: "#lab/idea",
    ideaNotes: 1,
    workingPaperTag: "lab/draft",
    workingPaperNotes: 1,
    paperNotesWithoutIdentifiers: { count: 52, paths: paths.slice(0, 50) },
    possibleNonProjects: 1,
    excludedFolders: 1,
    excludedNotes: 1,
    privateNotes: 2,
  });
  expect(scan.notes.map(({ kind, path }) => [kind, path])).toEqual([
    ["paper_note", "Paper with ID.md"],
    ["project", "Projects/Reference.md"],
    ["project", "Projects/Tagged.md"],
    ["project", "Projects/Typed.md"],
  ]);
  expect(JSON.stringify(scan)).not.toMatch(
    /Hidden fixture|Secret fixture|Invisible|Escape/,
  );
});

it("matches any tag in a list, counts each tag and skips notes tagged as both kinds", async () => {
  const settings = validateConfig({
    vault: {
      root,
      ideaTag: ["type/idea", "#type/synthesis"],
      workingPaperTag: ["type/working-paper", "type/draft"],
    },
  }).vault;
  await note("Synthesis.md", "---\ntags: [type/synthesis]\n---\nBODY");
  await note("Idea.md", "---\ntags: '#type/idea'\n---\nBODY");
  await note("Draft.md", "---\ntags: [type/draft]\n---\nBODY");
  await note("Both.md", "---\ntags: [type/synthesis, type/draft]\n---\n");
  await note("Concept.md", "---\ntags: [type/concept]\n---\nBODY");
  const scan = await localVaultSource(
    await openVault(settings),
    settings,
  ).index();
  expect(scan.notes.map(({ kind, path }) => [kind, path])).toEqual([
    ["working_paper", "Draft.md"],
    ["idea", "Idea.md"],
    ["idea", "Synthesis.md"],
  ]);
  expect(scan.conventions).toMatchObject({
    ideaTag: "type/idea, #type/synthesis",
    ideaNotes: 3,
    workingPaperTag: "type/working-paper, type/draft",
    workingPaperNotes: 2,
  });
  expect(scan.tagCounts).toEqual({
    idea: { "type/idea": 1, "type/synthesis": 2 },
    workingPaper: { "type/working-paper": 0, "type/draft": 2 },
  });
  expect(scan.issues).toEqual([
    {
      path: "Both.md",
      reason:
        "The note has both an idea tag and a working-paper tag. Keep one kind.",
    },
  ]);
  const only = await localVaultSource(
    await openVault(settings),
    settings,
  ).index({ conventionsOnly: true });
  expect(only.issues).toEqual([]);
  expect(only.tagCounts).toEqual(scan.tagCounts);
});

it("changes only the requested YAML value or list, preserves CRLF and is idempotent", async () => {
  await note("Idea.md", rawIdea);
  const vault = await openVault({ ...config, write: true });
  const sink = localVaultSink(vault, { ...config, write: true });
  const target = { id: hash("Idea.md"), path: "Idea.md" };
  const link = {
    id: "req_link",
    kind: "link_paper" as const,
    target,
    baseHash: hash(rawIdea),
    paper,
  };
  expect(await sink.request(link)).toMatchObject({
    path: "Idea.md",
    changed: true,
  });
  const linked = rawIdea.replace(
    "[ '2406.09414' ]",
    "[ '2406.09414', \"2406.09415\" ]",
  );
  expect(await vault.read("Idea.md")).toBe(linked);
  expect(await sink.request(link)).toMatchObject({ changed: false });
  const status = {
    id: "req_status",
    kind: "set_status" as const,
    target,
    baseHash: hash(rawIdea),
    status: "parked" as const,
  };
  await expect(sink.request(status)).rejects.toThrow("changed since");
  expect(
    await sink.request({ ...status, baseHash: hash(linked) }),
  ).toMatchObject({ changed: true });
  expect(await vault.read("Idea.md")).toBe(
    linked.replace("'seed'", "'parked'"),
  );
});

it("protects handwritten blocks, appends captures once and honours read-only mode", async () => {
  await note("Paper.md", "Handwritten");
  const vault = await openVault(config);
  const capture = {
    id: "req_capture",
    kind: "capture" as const,
    title: "Promising",
    body: "Think about baselines",
    paper,
  };
  const preview = localVaultSink(vault, config);
  expect(await preview.request(capture)).toMatchObject({
    changed: true,
    path: "Inbox.md",
  });
  expect(await preview.block("Paper.md", paper)).toMatchObject({
    changed: true,
  });
  expect(await readdir(root)).toEqual(["Paper.md"]);
  expect(await vault.read("Paper.md")).toBe("Handwritten");
  const settings = { ...config, write: true };
  const sink = localVaultSink(await openVault(settings), settings);
  await sink.request(capture);
  expect(await sink.request(capture)).toMatchObject({ changed: false });
  expect(await vault.read("Inbox.md")).toMatch(
    /## From LitScout\n.*\n[^]*- Promising.*\[A stereo paper\]/,
  );
  await sink.block("Paper.md", paper);
  const before = (await vault.read("Paper.md"))!.replace(
    "A quick note",
    "Edited by hand",
  );
  await note("Paper.md", before);
  await expect(sink.block("Paper.md", paper)).rejects.toThrow("edited by hand");
  expect(await vault.read("Paper.md")).toBe(before);
});

it("refuses unsafe destinations and foreign digest files, and creates collision-safe paper notes", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings);
  const sink = localVaultSink(vault, settings);
  await writeFile(path.join(tmp, "Outside.md"), "Do not touch");
  await symlink(tmp, path.join(root, "Escape"));
  await symlink(path.join(tmp, "Outside.md"), path.join(root, "Link.md"));
  for (const file of [
    "../Outside.md",
    path.join(tmp, "Outside.md"),
    "Escape/Outside.md",
    "Link.md",
    "Private/New.md",
    "Secrets/Secret test.md",
  ])
    await expect(sink.block(file, paper)).rejects.toThrow();
  expect(await readFile(path.join(tmp, "Outside.md"), "utf8")).toBe(
    "Do not touch",
  );
  await note(
    path.posix.join(config.digestsDir, "2026-11-17.md"),
    "Owned by the old job",
  );
  await expect(sink.digest("2026-11-18", "Daily digest")).rejects.toThrow(
    "not written by LitScout",
  );
  expect(await sink.digest("2026-11-18", "Daily digest", true)).toMatchObject({
    changed: true,
  });
  expect(await sink.digest("2026-11-18", "Daily digest", true)).toMatchObject({
    changed: false,
  });
  await expect(sink.digest("2026-11-17", "Daily digest", true)).rejects.toThrow(
    "not written by LitScout",
  );
  await note("Papers/A stereo paper.md", "Existing");
  const create = { kind: "make_paper_note" as const, id: "req_create", paper };
  expect(await sink.request(create)).toMatchObject({
    path: "Papers/A stereo paper (2).md",
    changed: true,
  });
  expect(await sink.request(create)).toMatchObject({
    path: "Papers/A stereo paper (2).md",
    changed: false,
  });
  expect(await vault.read("Papers/A stereo paper.md")).toBe("Existing");
});

it("preserves block-list YAML comments and exact bytes outside the paper block", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings);
  const sink = localVaultSink(vault, settings);
  const idea =
    "---\ntags: [type/idea]\npapers:\n  # intro\n  - '2406.09414' # keep\n# trailing\nother: true\n---\nHandwritten\n";
  await note("Idea.md", idea);
  await sink.request({
    kind: "link_paper",
    id: "req_block",
    target: { id: hash("Idea.md"), path: "Idea.md" },
    baseHash: hash(idea),
    paper,
  });
  expect(await vault.read("Idea.md")).toBe(
    idea.replace("# trailing", '  - "2406.09415"\n# trailing'),
  );

  const prefix =
    "---\r\ntags: [type/paper]\r\narxiv: '2406.09415'\r\n---\r\nBefore\r\n";
  await note("Paper.md", prefix);
  await sink.block("Paper.md", paper);
  const prior = (await vault.read("Paper.md"))! + "Outside the block\r\n";
  await note("Paper.md", prior);
  await sink.block("Paper.md", { ...paper, notes: ["A different note"] });
  const after = (await vault.read("Paper.md"))!;
  expect(after).toContain("A different note");
  expect(after.split("<!-- litscout:begin -->")[0]).toBe(
    prior.split("<!-- litscout:begin -->")[0],
  );
  expect(after.split("<!-- litscout:end -->")[1]).toBe(
    prior.split("<!-- litscout:end -->")[1],
  );
  expect(
    (await sink.block("Paper.md", { ...paper, notes: ["A different note"] }))
      .changed,
  ).toBe(false);
});

it("skips ordinary Markdown and isolates each malformed candidate or unreadable note", async () => {
  await note(
    "Horizontal rule.md",
    "---\nOrdinary Markdown without frontmatter.\n",
  );
  await note(
    "Unrelated YAML.md",
    "---\ntags: [travel]\nstatus: x\nstatus: y\n---\n",
  );
  await note("Good idea.md", rawIdea);
  await note("Good flow.md", "---\n{ title: Test, tags: [type/idea] }\n---\n");
  await note(
    "Good sequence.md",
    "---\n'tags':\n- unrelated\n- '#type/idea'\n---\n",
  );
  await note("Projects/Good.md", "# Valid project");
  await note("Projects/Duplicate.md", "---\nstatus: x\nstatus: y\n---\n");
  await note(
    "Long title.md",
    "---\ntags: [type/idea]\ntitle: " + "x".repeat(513) + "\n---\n",
  );
  await note("Bad: path.md", rawIdea);
  await note("Back\\slash.md", rawIdea);
  await note("Odd: folder/Child.md", rawIdea);
  await writeFile(path.join(root, "Bad encoding.md"), Buffer.from([0xff]));
  await writeFile(
    path.join(root, "Oversized.md"),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  const result = await localVaultSource(
    await openVault(config),
    config,
  ).index();
  expect(result.notes.map(({ path }) => path)).toEqual([
    "Good flow.md",
    "Good idea.md",
    "Good sequence.md",
    "Projects/Good.md",
  ]);
  expect(result.issues.map(({ path }) => path).sort()).toEqual([
    "Back\\slash.md",
    "Bad encoding.md",
    "Bad: path.md",
    "Long title.md",
    "Odd: folder",
    "Oversized.md",
    "Projects/Duplicate.md",
  ]);
  expect(result.issues).toContainEqual({
    path: "Bad encoding.md",
    reason: "Expected a UTF-8 Markdown file.",
  });
});

it("normalizes exclusions at each path component and keeps private notes and optional descriptions out of the index", async () => {
  const settings = validateConfig({
    vault: {
      root,
      projects: ["Projects/*.md"],
      write: true,
      uploadDescriptions: false,
    },
  }).vault;
  settings.exclude.push("Café/**", "Résumé.md");
  await note("Cafe\u0301/Hidden.md", rawIdea);
  await note("Re\u0301sume\u0301.md", rawIdea);
  await note(".root-hidden.md", rawIdea);
  await note("Nested/.hidden/Child.md", rawIdea);
  await note("Nested/Client-nDa notes/Child.md", rawIdea);
  await note("topic-NdA draft.md", rawIdea);
  await note(
    "Projects/Private project.md",
    "---\nlitscout: private\ndescription: Offline only\n---\n",
  );
  await note(
    "Private idea.md",
    "---\ntags: [type/idea]\nlitscout: 'private'\n---\n",
  );
  await note(
    "Projects/Public project.md",
    "---\ndescription: Project description\n---\n",
  );
  await note(
    "Visible idea.md",
    "---\ntags: type/idea\ndescription: Idea description\n---\n",
  );
  const vault = await openVault(settings);
  await expect(vault.read("Cafe\u0301/Hidden.md")).rejects.toThrow("excluded");
  await expect(vault.read("Re\u0301sume\u0301.md")).rejects.toThrow("excluded");
  const sink = localVaultSink(vault, settings);
  await expect(
    sink.request({
      id: "req_excluded",
      kind: "set_status",
      target: {
        id: hash("Re\u0301sume\u0301.md"),
        path: "Re\u0301sume\u0301.md",
      },
      baseHash: hash(rawIdea),
      status: "parked",
    }),
  ).rejects.toThrow("excluded");
  const { notes, issues } = await localVaultSource(vault, settings).index();
  expect(
    notes.map(({ path, frontmatter }) => [
      path,
      "description" in frontmatter ? frontmatter.description : undefined,
    ]),
  ).toEqual([
    ["Projects/Public project.md", undefined],
    ["Visible idea.md", undefined],
  ]);
  expect(issues).toEqual([]);
  expect(validateConfig({}).vault.uploadDescriptions).toBe(true);
});

const pluginText = [
  "`$= dv.current()`",
  "<% tp.user.run() %>",
  "![](https://fixture.invalid/image)",
  "![[Other Note]]",
  "#injected",
  "[[Linked Note]]",
].join(" ");
function expectInert(text: string) {
  for (const fragment of ["`$=", "<%", "![](", "![[", "#injected", "[["])
    expect(text).not.toContain(fragment);
}

it("keeps vault plugins and Markdown embeds inert in captures, paper blocks, and generated titles", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings);
  const sink = localVaultSink(vault, settings);
  const external = {
    ...paper,
    title: pluginText,
    doi: "10.1000/stereo",
    notes: ["Before\n\n" + pluginText],
    summary: {
      tldr: pluginText,
      motivation: pluginText,
      method: pluginText,
      result: pluginText,
      conclusion: pluginText,
    },
    links: [{ kind: "pdf_oa", url: "https://fixture.invalid/paper.pdf" }],
  };
  await sink.request({
    id: "req_inert_capture",
    kind: "capture",
    title: pluginText,
    body: pluginText,
    paper: external,
  });
  const inbox = (await vault.read("Inbox.md"))!;
  expectInert(inbox);
  expect(inbox).toContain("](<https://doi.org/10.1000/stereo>)");
  await note("Existing.md", "User-owned **Markdown**");
  await sink.block("Existing.md", external);
  const block = (await vault.read("Existing.md"))!;
  expectInert(block);
  expect(block).toContain("User-owned **Markdown**");
  expect(block).toMatch(/> Before\n>\s*\n> /);
  expect(block).toContain("[PDF](<https://fixture.invalid/paper.pdf>)");
  expect(block).toContain(
    "[alphaXiv](<https://www.alphaxiv.org/abs/2406.09415>)",
  );
  const created = await sink.request({
    id: "req_inert_paper",
    kind: "make_paper_note",
    paper: external,
  });
  const output = (await vault.read(created.path))!;
  expectInert(output);
  expect(parseNote(output).doc.get("title")).toBe(pluginText);
  expect(output).toMatch(/^# /m);
  expect((await stat(path.join(root, "Papers"))).mode & 0o777).toBe(0o755);
});

it("keeps only validated HTTPS links in generated notes", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings),
    sink = localVaultSink(vault, settings);
  const dubious = {
    ...paper,
    arxiv: undefined,
    doi: undefined,
    url: "http://fixture.invalid/",
    links: [
      {
        kind: "pdf_oa",
        url: "https://user:password" + "@" + "fixture.invalid/automatic.pdf",
      },
      { kind: "pdf_oa", url: "https://fixture.invalid/trusted.pdf" },
    ],
  };
  await note("Existing.md", "Original");
  await sink.block("Existing.md", dubious);
  const block = (await vault.read("Existing.md"))!;
  expect(block).toContain("[PDF](<https://fixture.invalid/trusted.pdf>)");
  expect(block).not.toContain("automatic.pdf");
  await sink.request({
    id: "req_linkless",
    kind: "capture",
    title: "HTTP title",
    paper: { ...dubious, links: [] },
  });
  expect(await vault.read("Inbox.md")).not.toContain("http://");
});

it("rejects a status splice that would alter another frontmatter value through an alias", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings),
    sink = localVaultSink(vault, settings);
  const original =
    "---\ntags: [type/idea]\nstatus: &shared 'seed'\ncustom: *shared\n---\nUnchanged\n";
  await note("Idea.md", original);
  const change = {
    id: "req_alias",
    kind: "set_status" as const,
    target: { id: hash("Idea.md"), path: "Idea.md" },
    baseHash: hash(original),
    status: "parked" as const,
  };
  await expect(sink.request(change)).rejects.toThrow("other frontmatter");
  expect(await vault.read("Idea.md")).toBe(original);
});

it("keeps digest headings and HTTPS links while neutralising external Markdown", async () => {
  const settings = { ...config, write: true, digestsDir: "Digests" };
  const vault = await openVault(settings),
    sink = localVaultSink(vault, settings);
  await sink.digest(
    "2026-11-18",
    "# Reading\n\n**Radar**\n\n- [Keep](https://fixture.invalid/paper) " +
      "[Discard](http://fixture.invalid/unsafe) " +
      pluginText,
  );
  const output = (await vault.read("Digests/2026-11-18.md"))!;
  expectInert(output);
  expect(output).toContain("# Reading");
  expect(output).toContain("**Radar**");
  expect(output).toContain("[Keep](<https://fixture.invalid/paper>)");
  expect(output).not.toContain("](http://");
  expect(output).not.toContain("](<https://fixture.invalid/image>)");
});

it("resolves indexed paper references and leaves ambiguous titles unresolved", async () => {
  await note(
    "Refs/A.md",
    "---\ntags: [type/paper]\ntitle: Duplicate\narxiv: 2406.09410\n---\n",
  );
  await note(
    "Refs/B.md",
    "---\ntags: type/paper\ntitle: Duplicate\ndoi: 10.1000/Example\narxiv: [wrong]\n---\n",
  );
  await note("Refs/No ID.md", "---\ntags: type/paper\narxiv: W123\n---\n");
  await note("Refs/Invalid.md", "---\ntags: type/paper\ndoi: bad\n---\n");
  await note("Refs/Title only.md", "---\ntags: type/paper\n---\n");
  await note(
    "References.md",
    "---\ntags: [type/working-paper]\nideas: Idea\npapers: ['arXiv:2406.09410v4', '[[Refs/B.md#section|label]]', '[[Duplicate]]', '[[A]]', short, null]\n---\n",
  );
  await note("Context.md", "# Private body of a configured brief");
  await note("Selected via escape.md", '---\ntags: "type/\\u0069dea"\n---\n');
  const settings = { ...config, briefs: ["Context.md"] };
  const { notes, issues } = await localVaultSource(
    await openVault(settings),
    settings,
  ).index();
  expect(notes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "brief",
        path: "Context.md",
        frontmatter: {},
      }),
      expect.objectContaining({
        kind: "working_paper",
        frontmatter: {
          ideas: ["Idea"],
          papers: ["2406.09410", "10.1000/example", "[[Duplicate]]", "short"],
        },
      }),
      expect.objectContaining({ kind: "idea", path: "Selected via escape.md" }),
      expect.objectContaining({
        kind: "paper_note",
        path: "Refs/Title only.md",
        title: "Title only",
      }),
    ]),
  );
  expect(notes.some(({ path }) => /No ID|Invalid/.test(path))).toBe(false);
  expect(issues).toEqual([]);
});

it("reports a vanishing or unreadable file without copying details from an OS error", async () => {
  const vault = await openVault(config);
  const scan = localVaultSource(
    {
      ...vault,
      async *files() {
        yield* ["Gone.md", "Permission.md", "Good.md", "data.txt"];
      },
      async read(file) {
        if (file === "Gone.md") return null;
        if (file === "Permission.md")
          throw new Error("Untrusted OS diagnostic that stays local");
        if (file === "Good.md") return rawIdea;
        throw new Error("Do not read non-Markdown files");
      },
    },
    config,
  );
  expect(await scan.index()).toMatchObject({
    notes: [{ path: "Good.md" }],
    issues: [
      { path: "Gone.md", reason: "The file disappeared during indexing." },
      { path: "Permission.md", reason: "Could not read the vault file." },
    ],
  });
});

it("refuses to publish a partial scan when the index hard limit is reached", async () => {
  const { indexLimit } = await import("@litscout/pipeline/vault-contracts");
  const vault = await openVault(config);
  const scan = localVaultSource(
    {
      ...vault,
      async *files() {
        for (let n = 0; n <= indexLimit; n++) yield "Idea " + n + ".md";
      },
      async read() {
        return rawIdea;
      },
    },
    config,
  );
  await expect(scan.index()).rejects.toThrow("Vault index exceeds");
  expect(await scan.index({ conventionsOnly: true })).toMatchObject({
    notes: [],
    conventions: { ideaNotes: indexLimit + 1 },
  });
});

it("protects local notes from stale writes, non-directory parents, and a replaced vault root", async () => {
  const disabled = await openVault(config);
  await expect(disabled.write("Blocked.md", null, "text")).rejects.toThrow(
    "writes are off",
  );
  const settings = { ...config, write: true };
  const vault = await openVault(settings);
  await note("File.md", "Human edit");
  await expect(vault.write("File.md", "Old view", "new")).rejects.toThrow(
    "changed during sync",
  );
  await expect(vault.read("File.md/Nested.md")).rejects.toThrow(
    "parent must be a directory",
  );
  await expect(vault.read("File.md")).resolves.toBe("Human edit");
  await expect(async () => {
    for await (const _ of vault.files("File.md")) void _;
  }).rejects.toThrow("Expected a directory");
  const { rename } = await import("node:fs/promises");
  await rename(root, path.join(tmp, "old"));
  await mkdir(root);
  await expect(localVaultSource(vault, settings).index()).rejects.toThrow(
    "Vault root moved",
  );
  await expect(vault.read("File.md")).rejects.toThrow("Vault root moved");
});

it("declines invalid requests and reports rejected templates without leaving a new note", async () => {
  const settings = {
    ...config,
    write: true,
    digestsDir: "Digests",
    paperNotes: { ...config.paperNotes, template: "paper.md" },
    digestTemplate: "digest.md",
  };
  const vault = await openVault(settings),
    sink = localVaultSink(vault, settings, { configDir: tmp });
  const make = { kind: "make_paper_note" as const, id: "req_make", paper };
  await expect(sink.request({ ...make, paper: undefined })).rejects.toThrow(
    "no longer available",
  );
  await expect(
    sink.request({ ...make, paper: { ...paper, arxiv: "" } }),
  ).rejects.toThrow("identifier");
  await expect(sink.request({ ...make, topic: "Unmapped" })).rejects.toThrow(
    "No vault folder",
  );
  await expect(sink.request(make)).rejects.toThrow(
    "template could not be read",
  );
  await writeFile(
    path.join(tmp, "paper.md"),
    "---\ntags: [type/paper]\n---\n{{unknown}}",
  );
  await expect(sink.request(make)).rejects.toThrow(
    "Unsupported vault template",
  );
  await writeFile(
    path.join(tmp, "paper.md"),
    "---\ntags: [topic/other]\nlitscout_id: {{litscout_id}}\narxiv: {{arxiv}}\n---\n",
  );
  await expect(sink.request(make)).rejects.toThrow(
    "must include the paper tag",
  );
  await writeFile(
    path.join(tmp, "paper.md"),
    "---\ntags: '#type/paper'\nlitscout_id: {{litscout_id}}\ndoi: {{doi}}\n---\n# {{heading}}",
  );
  await expect(
    sink.request({
      ...make,
      paper: {
        ...paper,
        arxiv: undefined,
        doi: "10.1000/source",
        title: "...",
      },
    }),
  ).resolves.toMatchObject({ path: "Papers/Paper.md", changed: true });
  await expect(sink.digest("2026-02-31", "invalid")).rejects.toThrow(
    "Invalid digest",
  );
  await writeFile(path.join(tmp, "digest.md"), "Missing YAML {{date}}");
  await expect(sink.digest("2026-11-18", "digest")).rejects.toThrow(
    "must include YAML",
  );
  await writeFile(
    path.join(tmp, "digest.md"),
    "---\ndate: {{day}}\n---\nDigest",
  );
  await expect(sink.digest("2026-11-18", "digest")).resolves.toMatchObject({
    changed: true,
  });
  await expect(sink.digest("2026-11-18", "digest")).resolves.toMatchObject({
    changed: false,
  });
});

it("does not revive an unowned capture section or a stale target", async () => {
  const settings = { ...config, write: true };
  const vault = await openVault(settings),
    sink = localVaultSink(vault, settings);
  const capture = {
    id: "req_owned",
    kind: "capture" as const,
    title: "Simple",
  };
  await note("Inbox.md", "# Human heading\n\n## From LitScout");
  await sink.request(capture);
  const after = (await vault.read("Inbox.md"))!;
  expect(after.match(/## From LitScout/g)).toHaveLength(1);
  expect(after).toContain("- Simple");
  await note(
    "Inbox.md",
    after.replace("## From LitScout", "## Something else"),
  );
  await expect(sink.request({ ...capture, id: "req_new" })).rejects.toThrow(
    "outside its capture section",
  );
  const status = {
    id: "req_missing",
    kind: "set_status" as const,
    target: { id: hash("Gone.md"), path: "Gone.md" },
    status: "parked" as const,
    baseHash: hash(rawIdea),
  };
  await expect(
    sink.request({
      ...status,
      target: { ...status.target, id: hash("Different.md") },
    }),
  ).rejects.toThrow("Invalid target");
  await expect(sink.request(status)).rejects.toThrow("no longer exists");
  await note("Gone.md", rawIdea);
  await expect(
    sink.request({ ...status, resultHash: hash(rawIdea) }),
  ).resolves.toMatchObject({ changed: false });
  await expect(
    sink.request({ ...status, kind: "add_reading" }),
  ).rejects.toThrow("identifier");
});
