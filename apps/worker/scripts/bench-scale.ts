import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shiftDay } from "@litscout/pipeline/daily";
import { requiredScope } from "../src/api-auth";
import { scaleRuntime } from "./scale-runtime";
import { scaleCases } from "./scale-cases";
import { hash } from "./scale-seed";

type Stats = {
  calls: number;
  statements: number;
  maxParams: number;
  rows: number;
};
type Plan = { sql: string; rows: number; plan: string[] };
type Trace = { status: number; body: string; stats: Stats; plans: Plan[] };
const label = process.argv[2] ?? "scale";
const samples = Number(process.argv[3] ?? 25);
const filter = process.argv[4] ? new RegExp(process.argv[4], "i") : null;
const today = new Date().toISOString().slice(0, 10);
const newest = process.argv[5] ?? shiftDay(today, -1);
if (!Number.isInteger(samples) || samples < 1 || samples > 100)
  throw new Error("Expected 1–100 samples per case");
const warmup = Math.min(5, Math.ceil(samples / 4));
mkdirSync(".artifacts/m4i", { recursive: true });
const scratch = mkdtempSync(".artifacts/m4i/clock-");
try {
  const executable = join(scratch, "workerd-cpu");
  execFileSync("cc", [
    "-O2",
    fileURLToPath(new URL("./workerd-cpu.c", import.meta.url)),
    "-o",
    executable,
  ]);
  const cpu = (pid: string) =>
    Number(execFileSync(executable, [pid], { encoding: "utf8" }));
  const before = cpu(String(process.pid)),
    start = process.cpuUsage();
  let nodeNs: number;
  do {
    const usage = process.cpuUsage(start);
    nodeNs = (usage.user + usage.system) * 1000;
  } while (nodeNs < 50_000_000);
  const clockRatio = (cpu(String(process.pid)) - before) / nodeNs;
  if (clockRatio < 0.9 || clockRatio > 1.15)
    throw new Error("CPU clock calibration failed");
  const local = await scaleRuntime(label, newest);
  try {
    const pid = execFileSync(
      "pgrep",
      ["-P", String(process.pid), "-x", "workerd"],
      { encoding: "utf8" },
    ).trim();
    if (!/^\d+$/.test(pid))
      throw new Error("Expected one isolated workerd child");
    const cases = scaleCases(newest).filter(
      ({ name }) => !filter || filter.test(name),
    );
    console.log(
      JSON.stringify({
        label,
        newest,
        samples,
        warmup,
        clockRatio,
        node: process.version,
        arch: process.arch,
      }),
    );
    let requestIndex = 0;
    let failures = 0;
    const issue = async (scopes: string[]) => {
      const token =
        "lsk_" +
        Array.from(
          randomBytes(52),
          (byte) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32],
        ).join("");
      await local.db
        .prepare(
          "INSERT INTO api_tokens(id,name,hash,scopes,last_used_at) VALUES (?,'scale',?,?,?)",
        )
        .bind(
          "scale-" + token.slice(4),
          hash(token),
          JSON.stringify(scopes),
          new Date().toISOString(),
        )
        .run();
      return token;
    };
    for (const scenario of cases) {
      const method = scenario.method ?? "GET";
      const needsToken =
        scenario.path.startsWith("/api/v1/") &&
        !scenario.path.startsWith("/api/v1/public/");
      const scopes =
        scenario.path === "/mcp"
          ? ["read", "write"]
          : [
              requiredScope(
                method,
                new URL(scenario.path, "https://local").pathname,
              ),
            ];
      if (scenario.name.startsWith("Daily digest ") && method === "PUT")
        scopes.push("write");
      let token =
        needsToken || scenario.path === "/mcp"
          ? await issue(scopes)
          : undefined;
      const call = (trace = false) => {
        // Each test IP stays below public search's ten requests per minute.
        const ipGroup = Math.floor(requestIndex++ / 8);
        return local.endpoint.fetch("https://local" + scenario.path, {
          method,
          headers: {
            ...(token ? { authorization: "Bearer " + token } : {}),
            ...(trace ? { "x-scale-trace": "1" } : {}),
            "cf-connecting-ip": `192.0.${Math.floor(ipGroup / 256)}.${ipGroup % 256}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
          },
          ...(scenario.body === undefined
            ? {}
            : { body: JSON.stringify(scenario.body) }),
        });
      };
      const validate = (status: number, body: string) => {
        if (status !== 200)
          throw new Error(`HTTP ${status} ${body.slice(0, 2000)}`);
        const event = body
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!body.startsWith("{") && !event) return;
        const payload = JSON.parse(event?.slice(6) ?? body);
        if (
          payload.success === false ||
          payload.error ||
          payload.result?.isError
        )
          throw new Error(JSON.stringify(payload).slice(0, 2000));
        if (scenario.path === "/mcp" && !payload.result?.content)
          throw new Error("Missing MCP result");
        if (
          scenario.name.startsWith("Vault index stage") &&
          !payload.data?.accepted
        )
          throw new Error("Vault staging did not accept the notes");
        if (
          scenario.name.startsWith("Vault index publish") &&
          !payload.data?.published
        )
          throw new Error("Vault commit did not publish the snapshot");
        if (
          (scenario.name.startsWith("Daily ingest") ||
            scenario.name.startsWith("Daily summary ingest")) &&
          payload.data?.accepted !== Number(scenario.name.match(/\d+$/)?.[0])
        )
          throw new Error(
            "Ingest did not accept the entire batch: " +
              JSON.stringify(payload),
          );
      };
      try {
        await scenario.prepare?.(local.db);
        const trace = (await (await call(true)).json()) as Trace;
        validate(trace.status, trace.body);
        const timings: number[] = [];
        const stats: Stats = { ...trace.stats };
        let bytes = Buffer.byteLength(trace.body);
        for (let i = 0; i < samples + warmup; i++) {
          if (token && scenario.path === "/mcp" && i > 0 && i % 15 === 0)
            token = await issue(scopes);
          await scenario.prepare?.(local.db);
          const begin = cpu(pid);
          const reply = await call();
          const body = await reply.text();
          const elapsed = (cpu(pid) - begin) / 1e6;
          validate(reply.status, body);
          const measured = JSON.parse(
            reply.headers.get("x-scale-stats")!,
          ) as Stats;
          if (i < warmup) continue;
          timings.push(elapsed);
          for (const key of Object.keys(stats) as (keyof Stats)[])
            stats[key] = Math.max(stats[key], measured[key]);
          bytes = Math.max(bytes, Buffer.byteLength(body));
        }
        timings.sort((a, b) => a - b);
        const middle = Math.floor(timings.length / 2);
        const median =
          timings.length % 2
            ? timings[middle]!
            : (timings[middle - 1]! + timings[middle]!) / 2;
        const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
        console.log(
          JSON.stringify({
            name: scenario.name,
            ...stats,
            bytes,
            median,
            p95,
            plans: trace.plans,
          }),
        );
      } catch (error) {
        failures++;
        console.error(scenario.name, String(error));
      }
    }
    if (!cases.length || failures > 0) process.exitCode = 1;
  } finally {
    await local.worker.dispose();
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
