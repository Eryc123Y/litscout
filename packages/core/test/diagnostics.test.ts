import { expect, it } from "vitest";
import { errorDiagnostic, redactDiagnostic } from "../src/diagnostics";
it("L2 leaves stack line and column numbers intact even when an environment key is a digit", () => {
  const failure = new Error("Publisher failed");
  failure.stack =
    "Error: Publisher failed\n    at watch (file:///tmp/index.js:5599:1)\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)";
  expect(
    errorDiagnostic(failure, { OPENALEX_API_KEY: "1", AUTH_TOKEN: "5" }).stack,
  ).toBe(failure.stack);
  expect(redactDiagnostic("token=1 sequence=1234567890 api_key=42")).toBe(
    "token=1 sequence=1234567890 api_key=42",
  );
});
it("L2 redacts the S1 key patterns without altering adjacent stack coordinates", () => {
  for (const value of [
    "lsk_" + "X".repeat(12),
    "-----BEGIN PRIVATE KEY-----",
    "ssh-ed25519",
    "---- BEGIN SSH2 PUBLIC KEY ----",
    "AKIA" + "X".repeat(16),
    "a".repeat(32),
    "Q".repeat(32),
  ]) {
    const result = redactDiagnostic(
      `Error: ${value}\n at /tmp/index.js:5599:104`,
    );
    expect(result).not.toContain(value);
    expect(result).toContain("/tmp/index.js:5599:104");
  }
});
it("T2 retains an error's real class and stack while redacting credentials", () => {
  class TransportFailure extends Error {}
  const key = "lsk_" + "synthetic-private-key",
    failure = new TransportFailure(`HTTP rejected api_key=${key}`),
    result = errorDiagnostic(failure, { OPENALEX_API_KEY: key });
  expect(result.name).toBe("TransportFailure");
  expect(result.message).toContain("HTTP rejected");
  expect(result.stack).toContain("TransportFailure");
  expect(JSON.stringify(result)).not.toContain(key);
});
it("T2 diagnostics remain bounded and handle non-Error failures", () => {
  expect(errorDiagnostic("plain failure").message).toBe("plain failure");
  expect(errorDiagnostic(null).message).toBe("Unknown failure");
  const failure = new Error("x ".repeat(3000));
  failure.stack = undefined;
  const result = errorDiagnostic(failure);
  expect(result.message).toHaveLength(2000);
  expect(result.stack).toHaveLength(5000);
  expect(redactDiagnostic("token=private&next=1")).toBe("token=private&next=1");
});
it("L2 redacts only S1 patterns, rather than arbitrary environment values or query parameters", () => {
  const text =
    "api_key=p%20a%2Fs user=fixture https://public.example/path?token=1";
  expect(
    redactDiagnostic(text, {
      OPENALEX_API_KEY: "p a/s",
      OPENREVIEW_USERNAME: "fixture",
    }),
  ).toBe(text);
});
