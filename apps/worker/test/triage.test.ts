import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { databaseHarness } from "@litscout/db/test/harness";
import { readDayPage } from "@litscout/db/bounded-read";
import { addLibraryItem, listLibrary } from "@litscout/db/library";
import { readState, recordEvent } from "@litscout/db/library-state";
import { readTriageQueue } from "@litscout/db/triage-read";
import { libraryCommands } from "@litscout/pipeline/library-contracts";
import { app } from "../src/app";
import { registerFeedTools } from "../src/mcp-feed";
import { registerLibraryTools } from "../src/mcp-library";
import { workerEnv } from "./helpers/worker-env";

// Six papers on the reader's topics and one outside them. The brief picked
// two (one of them outside the topics) and put one on the radar; two of the
// others link public code.
const day = "2026-11-24";
const now = `${day}T02:00:00.000Z`;
const token = "lsk_" + "T".repeat(52);
let d1: D1Database, close: () => Promise<void>;
let env: ReturnType<typeof workerEnv>["env"];
const db = () => drizzle(d1);
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  d1 = h.db.$client as unknown as D1Database;
  env = { ...workerEnv().env, LOCAL_DEV: "true", DB: d1 };
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await d1.batch([
    d1
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_triage','test',?,?)",
      )
      .bind(hash, '["read","write"]'),
    d1
      .prepare("INSERT INTO feed_days(day,status) VALUES (?,'digested')")
      .bind(day),
    ...Array.from({ length: 7 }, (_, rank) => [
      d1
        .prepare(
          "INSERT INTO papers(id,title,title_norm,abstract,authors,source) VALUES (?,?,?,'An abstract.','[]','arxiv')",
        )
        .bind(`pap_t${rank}`, `Paper ${rank}`, `paper ${rank}`),
      d1
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted) VALUES (?,?,'arxiv',?,?,?)",
        )
        .bind(
          day,
          `pap_t${rank}`,
          rank,
          rank === 6 ? "[]" : '["Vision"]',
          rank === 6 ? 0 : 1,
        ),
    ]).flat(),
    ...["pap_t1", "pap_t3", "pap_t4"].map((id) =>
      d1
        .prepare(
          "INSERT INTO paper_links(id,paper_id,kind,url) VALUES (?,?,'code','https://github.com/example/repo')",
        )
        .bind(`lnk_${id}`, id),
    ),
    d1
      .prepare(
        "INSERT INTO digests(day,lang,kind,body_md,picks,radar) VALUES (?,'en','daily','Brief',?,?)",
      )
      .bind(
        day,
        '["pap_t5","pap_t6","pap_t3"]',
        '[{"paperId":"pap_t2","relation":"baseline","why":"Same task"}]',
      ),
  ]);
});
afterAll(async () => close?.());

const row = async (id: string) =>
  (await readDayPage(d1, day, { limit: 100 })).items.find(
    (item) => item.paperId === id,
  );

it("queues the radar, then the brief's picks in order, then papers with code", async () => {
  const queue = await readTriageQueue(d1, day, "en");
  expect(queue.items.map((item) => [item.paperId, item.reason])).toEqual([
    ["pap_t2", "radar"],
    ["pap_t5", "pick"],
    ["pap_t6", "pick"],
    ["pap_t3", "pick"],
    ["pap_t1", "code"],
    ["pap_t4", "code"],
  ]);
  expect(queue.toRead).toBe(0);
});

it("serves the queue to the signed-in reader", async () => {
  const response = await app.request(
    `/api/v1/feed/days/${day}/triage`,
    { headers: { authorization: "Bearer " + token } },
    env,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as {
    data: { items: { paperId: string }[] };
  };
  expect(body.data.items).toHaveLength(6);
});

it("skips a paper, hides it from the open list and takes the skip back", async () => {
  const skipped = await recordEvent(db(), "pap_t0", "skip", day, now, "feed");
  expect(skipped).toMatchObject({ skippedAt: now, libraryStatus: null });
  expect((await row("pap_t0"))?.readingState).toMatchObject({ skippedAt: now });
  const ids = async (decision: string) =>
    (
      await readDayPage(d1, day, { limit: 100, shortlisted: true, decision })
    ).items.map((item) => item.paperId);
  expect(await ids("open")).not.toContain("pap_t0");
  expect(await ids("skipped")).toEqual(["pap_t0"]);
  // A second skip is not a second event.
  await recordEvent(db(), "pap_t0", "skip", day, now, "feed");
  const events = await d1
    .prepare("SELECT count(*) AS n FROM events WHERE paper_id='pap_t0'")
    .first<{ n: number }>();
  expect(events?.n).toBe(1);
  const back = await recordEvent(db(), "pap_t0", "unskip", day, now, "feed");
  expect(back).toMatchObject({ skippedAt: null });
  expect(await ids("open")).toContain("pap_t0");
});

it("keeps a paper in To read, moves it to saved and never moves a paper being read", async () => {
  const item = await addLibraryItem(
    db(),
    "pap_t1",
    "feed",
    day,
    now,
    "to_read",
  );
  expect(item).toMatchObject({ status: "to_read" });
  expect((await row("pap_t1"))?.readingState).toMatchObject({
    library: "to_read",
  });
  expect((await readTriageQueue(d1, day, "en")).toRead).toBe(1);
  expect((await listLibrary(db(), { status: "to_read" })).items).toMatchObject([
    { paperId: "pap_t1" },
  ]);
  // An add that names no status leaves the entry where it is.
  expect(await addLibraryItem(db(), "pap_t1", "mcp", day, now)).toMatchObject({
    status: "to_read",
  });
  const saved = await addLibraryItem(db(), "pap_t1", "feed", day, now, "saved");
  expect(saved).toMatchObject({ status: "saved" });
  await d1
    .prepare(
      "UPDATE library_items SET status='reading' WHERE paper_id='pap_t1'",
    )
    .run();
  expect(
    await addLibraryItem(db(), "pap_t1", "feed", day, now, "to_read"),
  ).toMatchObject({ status: "reading" });
});

it("drops a skipped paper from To read, and keeping it again takes the skip back", async () => {
  await addLibraryItem(db(), "pap_t4", "feed", day, now, "to_read");
  const skipped = await recordEvent(db(), "pap_t4", "skip", day, now, "feed");
  expect(skipped).toMatchObject({ skippedAt: now, libraryRev: null });
  const kept = await addLibraryItem(db(), "pap_t4", "feed", day, now, "saved");
  expect(kept).toMatchObject({ status: "saved" });
  expect(
    (await readState(db(), { paperId: "pap_t4", limit: 1 })).items[0],
  ).toMatchObject({ skippedAt: null, libraryStatus: "saved" });
  // A paper kept in the library is not skipped: the skip changes nothing.
  expect(
    await recordEvent(db(), "pap_t4", "skip", day, now, "feed"),
  ).toMatchObject({ skippedAt: null, libraryStatus: "saved" });
});

it("saves plainly a paper that was skipped out of To read", async () => {
  await addLibraryItem(db(), "pap_t0", "feed", day, now, "to_read");
  await recordEvent(db(), "pap_t0", "skip", day, now, "feed");
  // No status named, as the MCP tool or an import adds a paper.
  expect(await addLibraryItem(db(), "pap_t0", "mcp", day, now)).toMatchObject({
    status: "saved",
  });
  await d1
    .prepare("UPDATE library_items SET deleted_at=?1 WHERE paper_id='pap_t0'")
    .bind(now)
    .run();
});

it("reads the open list straight from the index, with no candidate window", async () => {
  const queries: string[] = [];
  const tracked = {
    batch: d1.batch.bind(d1),
    prepare(text: string) {
      queries.push(text);
      return d1.prepare(text);
    },
  };
  const page = await readDayPage(tracked as never, day, {
    limit: 100,
    shortlisted: true,
    decision: "open",
  });
  expect(page.items.length).toBeGreaterThan(0);
  expect(queries.some((text) => text.includes("candidates"))).toBe(false);
});

it("filters the day by public code and by the reader's decision", async () => {
  const ids = async (filters: Record<string, unknown>) =>
    (
      await readDayPage(d1, day, { limit: 100, shortlisted: true, ...filters })
    ).items.map((item) => item.paperId);
  expect(await ids({ code: true })).toEqual(["pap_t1", "pap_t3", "pap_t4"]);
  expect(await ids({ decision: "saved" })).toEqual(["pap_t1", "pap_t4"]);
  expect(await ids({ decision: "to_read" })).toEqual([]);
  // The public feed ignores the reader's decisions.
  const open = await readDayPage(
    d1,
    day,
    { limit: 100, decision: "saved" },
    true,
  );
  expect(open.items).toHaveLength(7);
});

it("accepts the To read status over the API", async () => {
  const response = await app.request(
    "/api/v1/library",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        paperId: "pap_t5",
        source: "feed",
        status: "to_read",
      }),
    },
    env,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { paperId: "pap_t5", status: "to_read" },
  });
});

// The same decisions for an agent, through the MCP tools.
type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
}>;
function tools() {
  const registerTool = vi.fn();
  const toolEnv = { ...env, DB: d1 };
  registerFeedTools({ registerTool } as never, toolEnv as never, {
    read: true,
    write: true,
  });
  registerLibraryTools({ registerTool } as never, toolEnv as never, {
    read: true,
    write: true,
    identity: "test",
  });
  return async (name: string, args: Record<string, unknown>) => {
    const handler = registerTool.mock.calls.find(
      ([tool]) => tool === name,
    )![2] as Handler;
    const reply = await handler(args);
    expect(reply.isError, reply.content[0]!.text).toBeFalsy();
    return (JSON.parse(reply.content[0]!.text) as { result: never }).result;
  };
}

it("gives an agent the day's queue and the decision filters through get_day", async () => {
  const call = tools();
  const queue = (await call("get_day", { day, queue: true })) as {
    papers: {
      items: { paperId: string; reason: string }[];
      nextCursor: null;
      toRead: number;
    };
  };
  expect(queue.papers.items.map((item) => item.reason)).toEqual([
    "radar",
    "pick",
    "pick",
    "pick",
    "code",
    "code",
  ]);
  expect(queue.papers.nextCursor).toBe(null);
  expect(queue.papers.toRead).toBeGreaterThan(0);
  const ids = async (filters: Record<string, unknown>) =>
    (
      (await call("get_day", { day, ...filters })) as {
        papers: { items: { paperId: string }[] };
      }
    ).papers.items.map((item) => item.paperId);
  expect(await ids({ code: true })).toEqual(["pap_t1", "pap_t3", "pap_t4"]);
  expect(await ids({ decision: "saved" })).toEqual(["pap_t1", "pap_t4"]);
});

it("lets an agent skip a paper, take the skip back and save into To read", async () => {
  const call = tools();
  expect(
    await call("mark_paper", { paperId: "pap_t2", action: "skip" }),
  ).toMatchObject({ skippedAt: expect.any(String) });
  expect(
    (
      (await call("get_day", { day, decision: "skipped" })) as {
        papers: { items: { paperId: string }[] };
      }
    ).papers.items.map((item) => item.paperId),
  ).toEqual(["pap_t2"]);
  expect(
    await call("mark_paper", { paperId: "pap_t2", action: "unskip" }),
  ).toMatchObject({ skippedAt: null });
  expect(
    await call("save_paper", { query: "pap_t3", status: "to_read" }),
  ).toMatchObject({ status: "saved", item: { status: "to_read" } });
});

it("checks the new tool arguments", () => {
  const mark = libraryCommands.mark_paper;
  expect(mark.safeParse({ paperId: "pap_t0", action: "skip" }).success).toBe(
    true,
  );
  expect(
    mark.safeParse({ paperId: "pap_t0", action: "skip", rating: "up" }).success,
  ).toBe(false);
  expect(
    libraryCommands.save_paper.safeParse({ query: "pap_t0", status: "reading" })
      .success,
  ).toBe(false);
});
