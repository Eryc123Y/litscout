import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { expect, it, vi } from "vitest";
import { runCommand } from "../src/setup-commands";

it("reads trends with the requested filters and resumes backfill after quota refusal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-trends-"));
  try {
    const out: string[] = [];
    const uploaded: string[] = [];
    let pause = true;
    const inputPaper = {
      paperId: "paper",
      title: "Wavelets",
      abstract: "Stereo wavelets",
      topics: ["Depth"],
      shortlisted: true,
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const { pathname, searchParams } = new URL(String(input));
      const month = searchParams.get("month");
      const kind = searchParams.get("kind");
      if (pathname === "/api/v1/trends") {
        expect(searchParams.get("topic")).toBe("Depth");
        expect(month).toBe("2026-10");
        return Response.json({
          success: true,
          data: {
            topic: "Depth",
            month,
            currentMonth: "2026-11",
            history: [],
            detail: null,
          },
        });
      }
      if (pathname.endsWith("/window"))
        return Response.json({
          success: true,
          data: { oldestMonth: "2026-09" },
        });
      if (pathname.endsWith("/references")) {
        expect(searchParams.get("ids")).toBe('["older"]');
        return Response.json({
          success: true,
          data: [
            {
              ...inputPaper,
              paperId: "older",
              title: "Stereo in an older paper",
              topics: [],
            },
          ],
        });
      }
      if (pathname.endsWith("/source"))
        return Response.json({
          success: true,
          data: {
            items:
              kind === "papers" && month !== "2026-08"
                ? [{ ...inputPaper, day: `${month}-15` }]
                : kind === "events" && month === "2026-10"
                  ? [
                      {
                        paperId: "older",
                        kind: "save",
                        at: "2026-10-31T04:00:00Z",
                      },
                    ]
                  : [],
            nextCursor: null,
          },
        });
      if (pathname.endsWith("/budget"))
        return Response.json({
          success: true,
          data: {
            day: "2026-10-31",
            used: pause ? 80000 : 0,
            reserved: 0,
            limit: 80000,
            resetAt: "2026-11-01T00:00:00Z",
            staleLeasesReleased: 0,
          },
        });
      if (pathname.endsWith("/ingest/trends")) {
        const [{ month, volume, activity, comparison }] = JSON.parse(
          String(init?.body),
        ).rows;
        expect(volume).toBe(1);
        // Rising terms say which days of the month before they compare with.
        expect(comparison).toEqual(
          month === "2026-10"
            ? { days: 1, first: "2026-09-15", last: "2026-09-15" }
            : { days: 0, first: null, last: null },
        );
        expect(activity).toEqual(
          month === "2026-10"
            ? [{ paperId: "older", saved: true, rating: null }]
            : [],
        );
        uploaded.push(month);
        return Response.json({
          success: true,
          data: { rowsWritten: 1 },
          meta: { rowsWritten: 1 },
        });
      }
      throw new Error("Unexpected fixture URL " + pathname);
    };
    const config = defineConfig({
      instance: {
        name: "Test",
        publicUrl: "https://fixture.example",
        timezone: "Asia/Kuala_Lumpur",
      },
      topics: [{ name: "Depth", keywords: ["stereo"] }],
    });
    await mkdir(path.join(dir, "state"));
    const invoke = (args: string[]) =>
      runCommand(["trends", ...args, "--json"], {
        cwd: dir,
        dir: path.join(dir, "state"),
        templateDir: dir,
        bundlePath: "",
        isTTY: false,
        print: (line) => out.push(line),
        loadConfig: async () => config,
        fetch,
        run: vi.fn(),
        prompt: vi.fn(),
        fetchVenues: vi.fn(),
        flow: { token: "test", now: () => new Date("2026-10-31T17:00:00Z") },
      });
    const output = () => JSON.parse(out.at(-1)!).data;
    expect(await invoke(["--topic", "Depth", "--month", "2026-10"])).toBe(0);
    expect(output()).toMatchObject({ topic: "Depth", month: "2026-10" });
    expect(await invoke(["backfill"])).toBe(1);
    expect(output()).toMatchObject({
      status: "budget-stop",
      month: "2026-10",
      resumeAt: "2026-11-01T00:00:00Z",
    });
    expect(uploaded).toEqual([]);
    pause = false;
    expect(await invoke(["backfill"])).toBe(0);
    expect(output()).toMatchObject({ month: "2026-10", nextMonth: "2026-09" });
    expect(await invoke(["backfill"])).toBe(0);
    expect(output()).toMatchObject({ month: "2026-09", nextMonth: null });
    expect(await invoke(["backfill"])).toBe(2);
    expect(uploaded).toEqual(["2026-10", "2026-09"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
