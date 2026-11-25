import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  loadServerConfig,
  parseSecrets,
  workerOptions,
  compatibilityDate,
} from "../src/config";
import { nextDailyRun } from "../src/schedule";

const dir = () => mkdtempSync(path.join(tmpdir(), "litscout-server-"));
const vars = {
  PUBLIC_URL: "https://litscout.example.org",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  PUBLIC_FEED: "false",
};
function write(config: unknown, secrets = "MGMT_TOKEN=m\nCONSENT_SECRET=c\n") {
  const d = dir();
  writeFileSync(path.join(d, "secrets.env"), secrets);
  chmodSync(path.join(d, "secrets.env"), 0o600);
  writeFileSync(
    path.join(d, "server.json"),
    JSON.stringify({
      app: "/srv/app",
      state: "/srv/state",
      vars,
      secretsFile: path.join(d, "secrets.env"),
      ...(config as object),
    }),
  );
  return path.join(d, "server.json");
}

it("loads the config with defaults and the secrets file", () => {
  const { config, secrets } = loadServerConfig(write({}));
  expect(config).toMatchObject({
    host: "127.0.0.1",
    port: 8787,
    cronUtc: "02:00",
  });
  expect(secrets).toEqual({ MGMT_TOKEN: "m", CONSENT_SECRET: "c" });
});

it("refuses development switches and a non-https public URL", () => {
  expect(() =>
    loadServerConfig(write({ vars: { ...vars, LOCAL_DEV: "true" } })),
  ).toThrow(/LOCAL_DEV/);
  expect(() =>
    loadServerConfig(write({ vars: { ...vars, PUBLIC_RATE_LIMIT: "off" } })),
  ).toThrow(/PUBLIC_RATE_LIMIT/);
  expect(() =>
    loadServerConfig(write({ vars: { ...vars, PUBLIC_URL: "http://x" } })),
  ).toThrow(/https/);
});

it("runs a trial on this computer only when nothing else can reach it", () => {
  const local = { ...vars, PUBLIC_URL: "http://127.0.0.1:8787" };
  const { config, secrets } = loadServerConfig(
    write({ local: true, vars: local }),
  );
  // The Worker then takes a request to this computer as the owner's.
  expect(workerOptions(config, secrets).bindings).toMatchObject({
    LOCAL_OWNER: "true",
    LITSCOUT_RUNTIME: "server",
  });
  // Listening beyond this computer would give everyone on the network the
  // owner's rights.
  expect(() =>
    loadServerConfig(write({ local: true, host: "0.0.0.0", vars: local })),
  ).toThrow(/this computer/);
  expect(() =>
    loadServerConfig(write({ local: true, host: "192.168.1.20", vars: local })),
  ).toThrow(/this computer/);
  expect(() => loadServerConfig(write({ local: true }))).toThrow(/PUBLIC_URL/);
  // The switch comes from `local`, never from a variable.
  expect(() =>
    loadServerConfig(write({ vars: { ...vars, LOCAL_OWNER: "true" } })),
  ).toThrow(/LOCAL_OWNER/);
  // Without `local`, the address stays https.
  expect(() => loadServerConfig(write({ vars: local }))).toThrow(/https/);
  const remote = loadServerConfig(write({}));
  expect(
    workerOptions(remote.config, remote.secrets).bindings,
  ).not.toHaveProperty("LOCAL_OWNER");
});

it("refuses a secrets file others can read, and unknown secret names", () => {
  const file = write({});
  const secrets = JSON.parse(readFileSync(file, "utf8")).secretsFile;
  chmodSync(secrets, 0o644);
  expect(() => loadServerConfig(file)).toThrow(/600/);
  expect(() => parseSecrets("MGMT_TOKEN=m\nLOCAL_DEV=true\n")).toThrow(
    /LOCAL_DEV/,
  );
  expect(parseSecrets("# comment\n\nS2_API_KEY=k=v\n")).toEqual({
    S2_API_KEY: "k=v",
  });
});

it("runs the deployed Worker with persistent bindings and no development switches", () => {
  const { config, secrets } = loadServerConfig(write({ port: 9000 }));
  const options = workerOptions(config, secrets);
  expect(options).toMatchObject({
    modules: true,
    modulesRoot: "/srv/app",
    scriptPath: "/srv/app/worker.js",
    host: "127.0.0.1",
    port: 9000,
    cf: false,
    d1Databases: ["DB"],
    kvNamespaces: ["OAUTH_KV"],
    resourcePersistencePath: "/srv/state",
    durableObjects: {
      PAIRING_STORE: { className: "PairingStore", useSQLite: true },
      SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
    },
    assets: {
      directory: "/srv/app/web",
      binding: "ASSETS",
      run_worker_first: true,
    },
  });
  // The Worker learns it runs on an own server (Health and doctor show the
  // server's facts instead of Cloudflare's).
  expect(options.bindings).toEqual({
    ...vars,
    MGMT_TOKEN: "m",
    CONSENT_SECRET: "c",
    LITSCOUT_RUNTIME: "server",
  });
  expect(options.bindings).not.toHaveProperty("LOCAL_DEV");
});

it("uses the same compatibility settings as the Cloudflare deployment", () => {
  const template = readFileSync("apps/worker/wrangler.template.jsonc", "utf8");
  expect(template).toContain(`"compatibility_date": "${compatibilityDate}"`);
});

it("schedules the daily handler at the next UTC time", () => {
  expect(
    nextDailyRun(new Date("2026-11-22T01:00:00Z"), "02:00").toISOString(),
  ).toBe("2026-11-22T02:00:00.000Z");
  expect(
    nextDailyRun(new Date("2026-11-22T02:00:00Z"), "02:00").toISOString(),
  ).toBe("2026-11-23T02:00:00.000Z");
  expect(
    nextDailyRun(new Date("2026-11-22T23:59:00Z"), "00:30").toISOString(),
  ).toBe("2026-11-23T00:30:00.000Z");
});
