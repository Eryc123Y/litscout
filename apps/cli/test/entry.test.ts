import { afterEach, expect, it, vi } from "vitest";
const originalArgv = process.argv;
const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  Object.defineProperty(process, "stdin", originalStdin);
  vi.restoreAllMocks();
});
async function invoke(args: string[], input?: string) {
  vi.resetModules();
  process.argv = [process.execPath, "litscout", ...args];
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  if (input !== undefined)
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(input);
        },
      },
    });
  await import("../src/index");
  return { out, err, code: process.exitCode };
}
it("prints valid JSON help without configuration or a runner call", async () => {
  const r = await invoke(["--help", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.join("")).success).toBe(true);
});
it("supports JSON streaming help and uses error exit code 1 for invalid watch arguments", async () => {
  let r = await invoke(["watch", "--help", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.err[0]!).error).toContain("usage:");
  r = await invoke(["watch", "--json"]);
  expect(r.code).toBe(1);
});
it("returns no-work exit code 2 for an empty abstract batch without network calls", async () => {
  const r = await invoke(["abstracts", "--json"], "");
  expect(r.code).toBe(2);
  expect(r.out).toEqual([]);
});
it("preserves a successful streaming result through the command entry point", async () => {
  vi.doMock("@litscout/sources/watch/run", () => ({
    runWatch: async (
      _args: readonly string[],
      deps: { stdout: (text: string) => void },
    ) => {
      deps.stdout('{"title":"Synthetic paper"}\n');
      return 0;
    },
  }));
  try {
    const r = await invoke(["watch", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join(""))).toEqual({ title: "Synthetic paper" });
  } finally {
    vi.doUnmock("@litscout/sources/watch/run");
  }
});
