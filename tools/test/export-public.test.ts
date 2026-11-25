import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error A plain script with no type declarations.
import { brokenLinks, checkTree, headingAnchor } from "../export-public.mjs";

// The public tree is the repository without its working notes. Before it is
// published, nothing in it may point back at the notes, link to a file or
// heading that is gone, or name the private instance.
function tree(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "litscout-export-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}

it("passes a tree whose links and names all hold", () => {
  const root = tree({
    "README.md":
      "See the [guide](docs/guide.md#first-run) and [site](https://example.org).",
    "docs/guide.md":
      "# Guide\n\n## First run\n\nBack to the [README](../README.md).\n",
    "src/a.ts": "export const a = 1;\n",
  });
  expect(checkTree(root, { deny: ["private.example"] })).toEqual([]);
});

it("reports a link to a file or heading that is not in the tree", () => {
  const root = tree({
    "README.md":
      "The [notes](docs/build/plan.md), the [guide](docs/guide.md#gone) and [this](#here).\n\n## Here\n",
    "docs/guide.md": "# Guide\n\n```sh\n# [not a link](missing.md)\n```\n",
  });
  expect(checkTree(root)).toEqual([
    "README.md:1: names docs/build, which is not in the tree",
    "README.md: link to docs/build/plan.md, which is not in the tree",
    "README.md: link to docs/guide.md#gone, a heading that is not there",
  ]);
});

it("reports the private instance's names in any text file, whatever the case", () => {
  const root = tree({
    "docs/runbook.md": "Deploy to Reader.Private.Example first.\n",
    "scripts/pull.sh": "#!/bin/sh\nssh my-server true\n",
    "assets/logo.png": "\u0000binary reader.private.example",
  });
  expect(
    checkTree(root, { deny: ["reader.private.example", "", "My-Server"] }),
  ).toEqual([
    'docs/runbook.md:1: contains "reader.private.example"',
    'scripts/pull.sh:2: contains "my-server"',
  ]);
  // A first name is a pattern: as plain text it would match "Deploy".
  expect(
    checkTree(root, { denyPatterns: ["\\bDep\\b", "\\bDeploy\\b"] }),
  ).toEqual(["docs/runbook.md:1: matches /\\bDeploy\\b/"]);
  // Recorded listings hold real authors' names: patterns skip them, plain
  // strings do not.
  const recorded = tree({
    "packages/x/test/fixtures/listing.html": "Deploy Private.Example\n",
  });
  expect(
    checkTree(recorded, {
      deny: ["private.example"],
      denyPatterns: ["\\bDeploy\\b"],
    }),
  ).toEqual([
    'packages/x/test/fixtures/listing.html:1: contains "private.example"',
  ]);
});

it("gives a heading the anchor GitHub gives it", () => {
  expect(headingAnchor("7. Edit the config and update deployment")).toBe(
    "7-edit-the-config-and-update-deployment",
  );
  expect(headingAnchor("Use `litscout doctor` (optional)")).toBe(
    "use-litscout-doctor-optional",
  );
  expect(brokenLinks(tree({ "a.md": "# A\n" }), "a.md", "[up](#a)")).toEqual(
    [],
  );
});
