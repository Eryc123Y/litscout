import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lockState } from "../src/lock";

const folder = () => mkdtempSync(path.join(tmpdir(), "litscout-lock-"));

describe("lockState", () => {
  it("writes the pid and removes the lock on release", () => {
    const state = folder();
    const release = lockState(state);
    const file = path.join(state, ".lock");
    expect(readFileSync(file, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a folder held by another running process", () => {
    const state = folder();
    // The parent process is alive and is not this one.
    writeFileSync(path.join(state, ".lock"), String(process.ppid));
    expect(() => lockState(state)).toThrow(/Another litscout-server/);
  });

  it("replaces a lock left by a process that has gone", () => {
    const state = folder();
    writeFileSync(path.join(state, ".lock"), "999999");
    const release = lockState(state);
    expect(readFileSync(path.join(state, ".lock"), "utf8")).toBe(
      String(process.pid),
    );
    release();
  });

  it("replaces an unreadable lock", () => {
    const state = folder();
    writeFileSync(path.join(state, ".lock"), "");
    lockState(state)();
    expect(existsSync(path.join(state, ".lock"))).toBe(false);
  });
});
