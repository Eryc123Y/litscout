import { expect, it, vi } from "vitest";
import { app } from "../src/app";
function request(body: ReadableStream<Uint8Array>, length?: number) {
  return app.request(
    "/api/v1/digests/2026-11-17",
    {
      method: "PUT",
      body,
      duplex: "half",
      headers: {
        "Content-Type": "application/json",
        ...(length === undefined ? {} : { "content-length": String(length) }),
      },
    } as RequestInit,
    { LOCAL_DEV: "true" },
  );
}
it("R8 declared oversize is rejected without reading or cancelling the request stream", async () => {
  const pull = vi.fn(),
    cancel = vi.fn();
  const response = await request(
    new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
    1100000,
  );
  expect(response.status).toBe(413);
  expect(pull).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
it("R8 chunked oversize drains to EOF below the hard ceiling instead of cancelling mid-upload", async () => {
  const sizes = [300 * 1024, 300 * 1024, 400 * 1024, 100 * 1024];
  let reads = 0,
    finished = false;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const size = sizes[reads++];
        if (size === undefined) {
          finished = true;
          c.close();
        } else c.enqueue(new Uint8Array(size));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const response = await request(body);
  expect(response.status).toBe(413);
  expect(finished).toBe(true);
  expect(reads).toBe(5);
  expect(cancel).not.toHaveBeenCalled();
});
it("R8 draining has a hard ceiling and never reads an unbounded body", async () => {
  let reads = 0;
  const cancel = vi.fn();
  const response = await request(
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          reads++;
          c.enqueue(new Uint8Array(256 * 1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
  expect(response.status).toBe(413);
  expect(cancel).toHaveBeenCalledOnce();
  expect(reads).toBe(9);
});
it("R8 a chunked body exactly at the drain ceiling still reaches EOF and returns 413", async () => {
  let sent = 0,
    finished = false;
  const cancel = vi.fn();
  const response = await request(
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (sent === 2 * 1024 * 1024) {
            finished = true;
            c.close();
            return;
          }
          c.enqueue(new Uint8Array(64 * 1024));
          sent += 64 * 1024;
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
  expect(response.status).toBe(413);
  expect(finished).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
});
