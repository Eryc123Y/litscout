import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { alphaXivCapture } from "../src/alphaxiv-capture";
import type { FlowDeps } from "../src/flow-runtime";

// `alphaxiv capture` asks Claude Code, limited to alphaXiv's two read tools,
// to list the library and the annotated papers, reads the tools' raw results
// from its stream (a large result is saved by Claude Code to a file under
// ~/.claude), writes the snapshot the import expects, and imports it.
const takenAt = "2026-11-22T14:18:54.000Z";
const library = {
  folders: [
    {
      folder_id: "10000000-0000-4000-8000-000000000001",
      name: "Want to read",
      type: "default-to-read",
      parent_id: null,
      sharing_status: "not_shared",
      paper_count: 3,
      papers: [
        {
          universal_paper_id: "2611.00001",
          title: "Stereo geometry",
          type: "public",
          publication_date: "2026-11-18",
        },
        {
          universal_paper_id: "fe412a99-c899-412e-a8f3-9c412b7882d6",
          title: "An upload",
          type: "private",
          publication_date: null,
        },
      ],
    },
    {
      folder_id: "10000000-0000-4000-8000-000000000002",
      name: "Depth",
      type: "custom",
      parent_id: "10000000-0000-4000-8000-000000000001",
      sharing_status: "not_shared",
      paper_count: 0,
      papers: [],
    },
  ],
};
const event = (value: unknown) => JSON.stringify(value);
const toolUse = (id: string, name: string) =>
  event({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name: `mcp__claude_ai_alphaXiv__${name}` },
      ],
    },
  });
const toolResult = (id: string, text: string) =>
  event({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text }],
        },
      ],
    },
  });
const done = event({ type: "result", subtype: "success", result: "DONE" });

async function setup(
  run: (paths: { home: string; dir: string }) => Promise<void>,
) {
  const home = await mkdtemp(path.join(tmpdir(), "litscout-capture-"));
  try {
    await run({ home, dir: path.join(home, "litscout", "etc", "alphaxiv") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
const on = defineConfig({ library: { alphaxivCapture: "claude" } });
const deps = (stdout: string, code = 0) => {
  const capture = vi.fn(async () => ({ code, stdout, stderr: "" }));
  return {
    capture,
    deps: {
      flow: { capture, now: () => new Date(takenAt) },
    } as unknown as FlowDeps,
  };
};

it("is off unless the config names a client, and then asks nothing", async () => {
  await setup(async ({ home, dir }) => {
    const { capture, deps: flow } = deps(done);
    const result = await alphaXivCapture(
      { import: true, dir },
      flow,
      defineConfig({}),
      { home },
    );
    expect(result).toMatchObject({ empty: true, data: { status: "off" } });
    expect(capture).not.toHaveBeenCalled();
  });
});

it("reads a library result Claude Code saved to a file, writes the snapshot and imports it", async () => {
  await setup(async ({ home, dir }) => {
    // Claude Code keeps a large result in the session's tool-results folder.
    const session = path.join(
      home,
      ".claude",
      "projects",
      "-tmp",
      "4a5246b7-7e5a-4a7c-87ae-27f1c4ac5fa6",
    );
    const saved = path.join(session, "tool-results", "out.txt");
    await mkdir(path.dirname(saved), { recursive: true });
    await writeFile(saved, JSON.stringify(library));
    await writeFile(session + ".jsonl", "{}\n");
    const stdout = [
      toolUse("t1", "list_library"),
      toolUse("t2", "list_annotated_papers"),
      toolResult("t2", "The user has no notes or highlights on any paper."),
      toolResult(
        "t1",
        `<persisted-output>\nOutput too large (76.1KB). Full output saved to: ${saved}\n</persisted-output>`,
      ),
      done,
    ].join("\n");
    const { capture, deps: flow } = deps(stdout);
    const imported = vi.fn(async (file: string) => ({
      data: {
        status: "synced",
        file,
        counts: { add: 1, update: 0, remove: 0, restore: 0 },
      },
    }));
    const result = await alphaXivCapture({ import: true, dir }, flow, on, {
      home,
      importSnapshot: imported,
    });
    const [prompt] = capture.mock.calls[0] as unknown as [string];
    expect(prompt).toMatch(/list_library.*include_papers/s);
    expect(result.data).toMatchObject({
      status: "synced",
      folders: 2,
      memberships: 2,
      annotations: 0,
    });
    const last = path.join(dir, "alphaxiv-last.json");
    expect(imported).toHaveBeenCalledWith(
      path.join(dir, "alphaxiv-pending.json"),
    );
    const snapshot = JSON.parse(await readFile(last, "utf8"));
    expect(snapshot).toEqual({
      takenAt,
      folders: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          name: "Want to read",
          type: "default-to-read",
          parentId: null,
          paperCount: 3,
          complete: false,
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          name: "Depth",
          type: "custom",
          parentId: "10000000-0000-4000-8000-000000000001",
          paperCount: 0,
          complete: true,
        },
      ],
      memberships: [
        {
          folderId: "10000000-0000-4000-8000-000000000001",
          paperId: "2611.00001",
          paperType: "public",
          title: "Stereo geometry",
          publicationDate: "2026-11-18",
        },
        {
          folderId: "10000000-0000-4000-8000-000000000001",
          paperId: "fe412a99-c899-412e-a8f3-9c412b7882d6",
          paperType: "private",
          title: "An upload",
          publicationDate: null,
        },
      ],
      annotations: [],
    });
    expect((await stat(last)).mode & 0o777).toBe(0o600);
    // The capture's session (results and transcript) is removed once read.
    await expect(stat(session)).rejects.toThrow();
    await expect(stat(session + ".jsonl")).rejects.toThrow();
    // The agent keeps its session so the saved result survives its exit.
    expect(capture.mock.calls).toHaveLength(1);
  });
});

it("maps public annotations, and keeps the last ones when a page cannot be read", async () => {
  await setup(async ({ home, dir }) => {
    const annotated = {
      papers: [
        {
          paper_id: "2611.00001",
          title: "Stereo geometry",
          highlight_count: 2,
          has_notes: true,
          last_annotated_at: "2026-11-18T11:00:00.000Z",
        },
        {
          paper_id: "fe412a99-c899-412e-a8f3-9c412b7882d6",
          type: "private",
          highlight_count: 1,
          has_notes: false,
          last_annotated_at: "2026-11-18T10:00:00.000Z",
        },
      ],
    };
    const read = async (text: string) => {
      const stdout = [
        toolUse("t1", "list_library"),
        toolResult("t1", JSON.stringify(library)),
        toolUse("t2", "list_annotated_papers"),
        toolResult("t2", text),
        done,
      ].join("\n");
      const result = await alphaXivCapture(
        { import: true, dir },
        deps(stdout).deps,
        on,
        { home, importSnapshot: async () => ({ data: { status: "synced" } }) },
      );
      return {
        result,
        snapshot: JSON.parse(
          await readFile(path.join(dir, "alphaxiv-last.json"), "utf8"),
        ),
      };
    };
    const first = await read(JSON.stringify(annotated));
    expect(first.snapshot.annotations).toEqual([
      {
        paperId: "2611.00001",
        highlightCount: 2,
        hasNotes: true,
        lastAnnotatedAt: "2026-11-18T11:00:00.000Z",
      },
    ]);
    const second = await read("Some format this version cannot read");
    expect(second.snapshot.annotations).toEqual(first.snapshot.annotations);
    expect((second.result.data as { warnings: string[] }).warnings).toEqual([
      expect.stringMatching(/annotated papers.*kept the last snapshot's/i),
    ]);
  });
});

it("stops without importing when the library is missing, the client fails or a saved file is outside ~/.claude", async () => {
  await setup(async ({ home, dir }) => {
    const importSnapshot = vi.fn();
    const attempt = (stdout: string, code = 0) =>
      alphaXivCapture({ import: true, dir }, deps(stdout, code).deps, on, {
        home,
        importSnapshot,
      });
    await expect(attempt(done)).rejects.toThrow(/did not list the library/i);
    await expect(attempt("", 1)).rejects.toThrow(/claude/i);
    await expect(
      attempt(
        [
          toolUse("t1", "list_library"),
          toolResult(
            "t1",
            "<persisted-output>Full output saved to: /etc/passwd</persisted-output>",
          ),
          done,
        ].join("\n"),
      ),
    ).rejects.toThrow(/outside/i);
    expect(importSnapshot).not.toHaveBeenCalled();
  });
});

it("also reads the other way Claude Code reports a saved result", async () => {
  await setup(async ({ home, dir }) => {
    const saved = path.join(home, ".claude", "projects", "-mac", "tool.txt");
    await mkdir(path.dirname(saved), { recursive: true });
    await writeFile(saved, JSON.stringify(library));
    const stdout = [
      toolUse("t1", "list_library"),
      toolResult(
        "t1",
        `Error: result (71,097 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text`,
      ),
      done,
    ].join("\n");
    const result = await alphaXivCapture(
      { import: false, dir },
      deps(stdout).deps,
      on,
      { home },
    );
    expect(result.data).toMatchObject({ status: "captured", memberships: 2 });
    await expect(stat(saved)).rejects.toThrow();
  });
});

it("says so when Claude Code did not keep a result it saved", async () => {
  await setup(async ({ home, dir }) => {
    const gone = path.join(
      home,
      ".claude",
      "projects",
      "-tmp",
      "s",
      "tool-results",
      "x.txt",
    );
    const stdout = [
      toolUse("t1", "list_library"),
      toolResult("t1", `Output has been saved to ${gone}.`),
      done,
    ].join("\n");
    await expect(
      alphaXivCapture({ import: false, dir }, deps(stdout).deps, on, { home }),
    ).rejects.toThrow(/did not keep/i);
  });
});

it("runs Claude Code with its session kept and only the two alphaXiv tools", async () => {
  const { captureArgv } = await import("../src/alphaxiv-capture");
  const argv = captureArgv();
  expect(argv).not.toContain("--no-session-persistence");
  expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
    "mcp__claude_ai_alphaXiv__list_library,mcp__claude_ai_alphaXiv__list_annotated_papers",
  );
});
