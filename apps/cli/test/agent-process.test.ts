import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  executeAgent,
  checkClient,
  agentEnvironment,
  agentProcess,
} from "../src/agent-process";
it("R1 passes exactly the login-capable environment allowlist to child processes", async () => {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SHELL",
    "USER",
    "LOGNAME",
  ];
  const allowed = Object.fromEntries(
    keys.map((key) => [key, `synthetic-${key}`]),
  );
  expect(
    agentEnvironment({
      ...allowed,
      PRIVATE_TEST_VALUE: "excluded",
      OPENAI_API_KEY: "excluded",
    }),
  ).toEqual(allowed);
});

it.skipIf(process.platform === "win32")(
  "ends at the timeout even when a grandchild holds stdout open",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "litscout-agent-group-"));
    const marker = path.join(root, "survived");
    const script = `
    const { spawn } = require('node:child_process');
    const grandchild = 'console.log("ready"); setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "survived"), 1200)';
    spawn(process.execPath, ['-e', grandchild, process.argv[1]], {stdio: ['ignore', 1, 2]});
    setInterval(() => {}, 1000);
  `;
    try {
      const started = performance.now();
      const result = await agentProcess(
        [process.execPath, "-e", script, marker],
        500,
        "",
      );
      expect(result).toMatchObject({
        code: 1,
        timedOut: true,
        stdout: "ready\n",
      });
      expect(performance.now() - started).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await expect(readFile(marker)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.skipIf(process.platform === "win32")(
  "kills a sleeping grandchild after the agent exits successfully",
  async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {stdio: 'ignore'});
      child.unref();
      console.log(child.pid);
    `;
    const result = await agentProcess(
      [process.execPath, "-e", script],
      5000,
      "",
    );
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(result.stdout.trim()).toMatch(/^[1-9]\d*$/);
    const pid = Number(result.stdout.trim());
    await vi.waitFor(async () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        expect(error).toHaveProperty("code", "ESRCH");
        return;
      }
      // A killed orphan may remain a zombie until its new parent reaps it.
      if (process.platform !== "linux") throw new Error(`PID ${pid} is alive`);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (stat) expect(stat.split(") ").at(-1)).toMatch(/^Z /);
    });
  },
);
it("A1/A2 closes stdin for all clients; Codex reads only its answer file and cleans temporary state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-fake-process-"));
  try {
    const script = path.join(root, "stand-in.cjs");
    await writeFile(
      script,
      `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const args=process.argv.slice(2);const result=JSON.stringify({input,args,cwd:process.cwd()});if(args.includes('-o')){require('node:fs').writeFileSync(args[args.indexOf('-o')+1],result);process.stdout.write('warnings and token counts');}else process.stdout.write(result);});`,
    );
    for (const client of ["claude", "codex", "antigravity"] as const) {
      const argv = [
        process.execPath,
        script,
        ...(client === "codex"
          ? ["-o", "{answerFile}", "-"]
          : ["-p", "{chunkPrompt}"]),
      ];
      const result = await executeAgent(
        argv,
        "PROMPT",
        { client, timeout: 3 },
        { dir: root, cwd: root },
      );
      expect(result.code).toBe(0);
      const answer = JSON.parse(result.text);
      expect(answer.input).toBe(client === "codex" ? "PROMPT" : "");
      expect(answer.args).toContain(client === "codex" ? "-" : "PROMPT");
      await expect(
        import("node:fs/promises").then((fs) => fs.stat(answer.cwd)),
      ).rejects.toHaveProperty("code", "ENOENT");
    }
    for (const content of ["", "missing"]) {
      const result = await executeAgent(
        [
          process.execPath,
          "-e",
          content === ""
            ? "require('node:fs').writeFileSync(process.argv[1],'');"
            : "process.stdout.write('do not use stdout');",
          "{answerFile}",
        ],
        "P",
        { client: "codex", timeout: 3 },
        { dir: root, cwd: root },
      );
      expect(result.code).not.toBe(0);
      expect(result.text).toContain("answer file");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("A4 checks auth exactly once with closed input and a 20-second timeout without logging diagnostics", async () => {
  const run = vi.fn(async () => ({
    code: 0,
    stdout: '{"loggedIn":true}',
    stderr: "private diagnostic",
  }));
  for (const client of ["claude", "codex", "antigravity"] as const)
    expect(await checkClient(client, run)).toEqual({
      client,
      usable: true,
      reason: "ready",
    });
  expect(run.mock.calls).toEqual([
    [["claude", "auth", "status"], 20000, ""],
    [["codex", "login", "status"], 20000, ""],
    [["agy", "models"], 20000, ""],
  ]);
  run.mockResolvedValue({
    code: 0,
    stdout: '{"loggedIn":false}',
    stderr: "private diagnostic",
  });
  expect(await checkClient("claude", run)).toMatchObject({
    usable: false,
    reason: "not logged in",
  });
  run.mockRejectedValue(new Error("private diagnostic"));
  expect(JSON.stringify(await checkClient("codex", run))).not.toContain(
    "private diagnostic",
  );
});

it("sends built-in Claude Code and Antigravity prompts on stdin, never as an argument", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-stdin-"));
  try {
    const script = path.join(root, "stand-in.cjs");
    // Echoes stdin; with --output-format stream-json it answers as Antigravity does.
    await writeFile(
      script,
      `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const args=process.argv.slice(2);if(args.includes('stream-json')){const m=JSON.parse(input.trim());process.stdout.write(JSON.stringify({event:'init',init:{}})+'\\n'+JSON.stringify({event:'result',result:{status:'SUCCESS',response:'ANSWER:'+m.message.content.length+':'+args.length}})+'\\n');}else process.stdout.write('ANSWER:'+input.length+':'+args.length);});`,
    );
    const prompt = "x".repeat(300_000);
    const claude = await executeAgent(
      [process.execPath, script, "-p", "--model", "haiku"],
      prompt,
      { client: "claude", timeout: 5 },
      { dir: root, cwd: root },
    );
    expect(claude).toMatchObject({ code: 0, text: "ANSWER:300000:3" });
    const agy = await executeAgent(
      [
        process.execPath,
        script,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "-p=",
      ],
      prompt,
      { client: "antigravity", timeout: 5 },
      { dir: root, cwd: root },
    );
    expect(agy).toMatchObject({ code: 0, text: "ANSWER:300000:5" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports an Antigravity stream error as a failed answer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-stream-"));
  try {
    const result = await executeAgent(
      [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({event:'result',result:{status:'ERROR',response:'',error:'quota exhausted'}})+'\\n'))",
        "--",
        "--output-format",
        "stream-json",
      ],
      "P",
      { client: "antigravity", timeout: 5 },
      { dir: root, cwd: root },
    );
    expect(result.code).not.toBe(0);
    expect(result.diagnostic).toContain("quota exhausted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a client running when it echoes a long prompt on stderr, and keeps the end of that stream", async () => {
  // Codex writes the prompt back on stderr; a digest prompt is about 1 MB.
  const result = await agentProcess(
    [
      process.execPath,
      "-e",
      "process.stderr.write('echo 401 Unauthorized '.repeat(150000), () => { process.stderr.write('LAST LINE'); process.stdout.write('ANSWER'); })",
    ],
    10_000,
    "",
  );
  expect(result).toMatchObject({ code: 0, stdout: "ANSWER" });
  expect(result.spawnError).toBeUndefined();
  expect(result.stderr.endsWith("LAST LINE")).toBe(true);
  expect(result.stderr.length).toBeLessThanOrEqual(64_000);
});

it("still stops a client whose answer on stdout passes the limit", async () => {
  const result = await agentProcess(
    [
      process.execPath,
      "-e",
      "const big='x'.repeat(1_100_000);process.stdout.write(big,()=>setTimeout(()=>{},5000))",
    ],
    10_000,
    "",
  );
  expect(result.code).toBe(1);
  expect(result.spawnError).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
});

it("kills a timed-out agent that traps SIGTERM and returns a timeout diagnostic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-timeout-"));
  try {
    const result = await executeAgent(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(7), 800);',
      ],
      "",
      { client: "cmd", timeout: 0.2 },
      { dir, cwd: dir },
    );
    expect(result).toMatchObject({ code: 1, diagnostic: "Agent timed out" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads Claude Code's checked draft from its JSON envelope and reports an error result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-envelope-"));
  // Prints the envelope given as its first argument and exits with the second.
  const claude = (stdout: string, code = 0) =>
    executeAgent(
      [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(process.argv[1]);process.exitCode=Number(process.argv[2])})",
        "--",
        stdout,
        String(code),
        "--output-format",
        "json",
      ],
      "P",
      { client: "claude", timeout: 5 },
      { dir: root, cwd: root },
    );
  const envelope = (fields: object) =>
    JSON.stringify({ type: "result", subtype: "success", ...fields });
  try {
    const draft = { day: "2026-11-17", other: [] };
    await expect(
      claude(
        envelope({
          is_error: false,
          result: "Here is the draft.",
          structured_output: draft,
        }),
      ),
    ).resolves.toMatchObject({ code: 0, text: JSON.stringify(draft) });
    // Without structured output, the answer text is read as before.
    await expect(
      claude(envelope({ is_error: false, result: '{"day":"2026-11-17"}' })),
    ).resolves.toMatchObject({ code: 0, text: '{"day":"2026-11-17"}' });
    for (const [stdout, code, message] of [
      [
        envelope({ is_error: true, result: "Prompt is too long" }),
        1,
        "Prompt is too long",
      ],
      [
        envelope({
          is_error: true,
          result:
            "API Error: 400 tools.1.custom.input_schema: JSON schema is invalid",
        }),
        0,
        "API Error: 400",
      ],
      [
        envelope({ is_error: false, result: "API Error: 529 Overloaded" }),
        0,
        "API Error: 529",
      ],
    ] as const) {
      const answer = await claude(stdout, code);
      expect(answer.code).not.toBe(0);
      expect(answer.text).toBe("");
      expect(answer.diagnostic).toContain(message);
    }
    // A client that prints plain text keeps the plain-text path.
    await expect(claude("plain answer")).resolves.toMatchObject({
      code: 0,
      text: "plain answer",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
