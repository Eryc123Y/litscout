// Loaded only by the rehearsal's built CLI and its Wrangler child process.
import assert from "node:assert/strict";

assert.equal(process.env.NODE_ENV, "test");

function loopbackOrigin(value) {
  const url = new URL(value);
  assert.equal(url.hostname, "127.0.0.1", "Rehearsal requires a loopback host");
  assert.ok(["http:", "https:"].includes(url.protocol));
  assert.ok(
    url.port && value === url.origin,
    "Expected an explicit local origin",
  );
  return url.origin;
}

const worker = loopbackOrigin(process.env.LITSCOUT_REHEARSAL_WORKER);
const fixtures = loopbackOrigin(process.env.LITSCOUT_REHEARSAL_SOURCES);
const routes = new Map([
  ["https://arxiv.org", /^\/list\/cs\.CV\/(new|recent)$/],
  ["https://www.jmlr.org", /^\/jmlr\.xml$/],
  ["https://huggingface.co", /^\/api\/daily_papers$/],
]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === worker) {
    return realFetch(input, { ...init, redirect: "error" });
  }
  if (
    routes.get(url.origin)?.test(url.pathname) &&
    !(input instanceof Request)
  ) {
    return realFetch(new URL(url.pathname + url.search, fixtures), {
      ...init,
      redirect: "error",
    });
  }
  // Some source readers catch fetch errors and downgrade them to warnings.
  process.stderr.write(
    `Unexpected rehearsal request: ${url.origin}${url.pathname}\n`,
  );
  throw new Error("Rehearsal permits only Worker and fixture requests");
};

const instant = Date.parse(process.env.LITSCOUT_REHEARSAL_NOW);
assert.ok(Number.isFinite(instant), "Expected a rehearsal clock");
globalThis.Date = new Proxy(Date, {
  apply: (DateClass) => new DateClass(instant).toString(),
  construct: (DateClass, args, target) =>
    Reflect.construct(DateClass, args.length ? args : [instant], target),
  get: (DateClass, name, receiver) =>
    name === "now" ? () => instant : Reflect.get(DateClass, name, receiver),
});

if (/\/wrangler\/bin\/wrangler\.js$/.test(process.argv[1] ?? "")) {
  const [command, subcommand] = process.argv.slice(2);
  let result;
  if (command === "--version") result = "4.151.0";
  else if (command === "whoami") result = "Authenticated fixture account";
  else if (command === "d1" && subcommand === "info")
    result = '{"database_size":0,"rows_read_24h":0,"rows_written_24h":0}';
  else if (command === "d1" && subcommand === "execute")
    result = '[{"results":[]}]';
  else throw new Error("Unexpected Wrangler command in offline rehearsal");
  process.stdout.write(result + "\n", () => process.exit(0));
  // Keep the real entry point from running while stdout drains.
  await new Promise(() => {});
}
