import { expect, it } from "vitest";
import { assetResponse } from "../src/assets";

const assets = (headers: Record<string, string> = {}, status = 200) =>
  ({
    fetch: async () => new Response("body", { status, headers }),
  }) as unknown as Fetcher;

it("lets browsers keep content-hashed assets without asking again", async () => {
  const hashed = await assetResponse(
    new Request("https://litscout.test/assets/index-CCE0mIhW.js"),
    assets({ "content-type": "text/javascript" }),
  );
  expect(hashed.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(hashed.headers.get("content-type")).toBe("text/javascript");
  expect(await hashed.text()).toBe("body");
});

it("leaves the app shell and missing files to be revalidated", async () => {
  const shell = await assetResponse(
    new Request("https://litscout.test/app/today"),
    assets({ "cache-control": "public, max-age=0, must-revalidate" }),
  );
  expect(shell.headers.get("cache-control")).toBe(
    "public, max-age=0, must-revalidate",
  );
  const missing = await assetResponse(
    new Request("https://litscout.test/assets/gone-12345678.js"),
    assets({}, 404),
  );
  expect(missing.headers.get("cache-control")).toBeNull();
  // A fallback page answering for a deleted chunk must not be kept as it.
  const fallback = await assetResponse(
    new Request("https://litscout.test/assets/Library-AbCd1234.js"),
    assets({ "content-type": "text/html; charset=utf-8" }),
  );
  expect(fallback.headers.get("cache-control")).toBeNull();
  const lowercase = await assetResponse(
    new Request("https://litscout.test/assets/my-longname.svg"),
    assets(),
  );
  expect(lowercase.headers.get("cache-control")).toBeNull();
  // An unhashed name under /assets is not safe to keep for a year.
  const plain = await assetResponse(
    new Request("https://litscout.test/assets/logo.svg"),
    assets(),
  );
  expect(plain.headers.get("cache-control")).toBeNull();
});
