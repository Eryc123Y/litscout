import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loopbackHost, type LitScoutConfig } from "@litscout/core";
import { privateJson } from "./state";
import { deploymentVars } from "./web-vars";
import { UsageError } from "./command-types";

/** On an own server the write limit only guards against a runaway writer. */
const serverWriteLimit = "1000000";
const folders = ["etc", "state", "logs", "backups", "releases"];

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
const newSecret = () =>
  (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");

/** The secrets already on the server, so --force never replaces them. */
async function existingSecrets(file: string) {
  const text = await readFile(file, "utf8").catch(() => "");
  const value = (key: string) =>
    text.match(new RegExp(`^${key}=(\\S+)$`, "m"))?.[1];
  return { token: value("MGMT_TOKEN"), consent: value("CONSENT_SECRET") };
}
async function existingState(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as { token?: string };
  } catch {
    return null;
  }
}
async function privateText(file: string, text: string) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

export type ServerInitOptions = {
  base?: string;
  /** A trial on this computer: no public address and no sign-in. */
  local?: boolean;
  force: boolean;
  dryRun: boolean;
};

/** `server init`: prepare an own server from litscout.config.ts. Writes the
 * LitScout folder (mode 700 folders), etc/server.json with the Worker's vars
 * for `server.js serve`, etc/secrets.env with a new management token and
 * consent secret, and the CLI state that `token create --save-only` reads.
 * Existing secrets are kept; settings are rewritten only with --force; CLI
 * state with another management token is never replaced. With --local the
 * server is a trial on this computer: it runs the build this CLI is part
 * of, listens on the loopback address in instance.publicUrl, and needs no
 * sign-in. */
export async function serverInit(
  options: ServerInitOptions,
  deps: { cwd: string; dir: string; templateDir: string },
  config: LitScoutConfig,
) {
  const publicUrl = config.instance.publicUrl;
  const address =
    publicUrl && URL.canParse(publicUrl) ? new URL(publicUrl) : undefined;
  const here = address?.protocol === "http:" && loopbackHost(address.hostname);
  if (options.local && !here)
    throw new UsageError(
      'A trial on this computer needs instance.publicUrl: "http://127.0.0.1:8787" in the config',
    );
  if (!options.local && here)
    throw new UsageError(
      "instance.publicUrl is this computer's address: add --local for a trial here, or set the server's public https address",
    );
  if (!publicUrl || !address || (!here && address.protocol !== "https:"))
    throw new UsageError(
      "Set instance.publicUrl to the server's public https address first",
    );
  const base = path.resolve(
    deps.cwd,
    options.base ?? path.join(homedir(), "litscout"),
  );
  const etc = path.join(base, "etc");
  const files = {
    server: path.join(etc, "server.json"),
    secrets: path.join(etc, "secrets.env"),
    state: path.join(deps.dir, "state.json"),
  };
  if ((await exists(files.server)) && !options.force)
    throw new UsageError(
      `${files.server} exists; rerun with --force to rewrite it (secrets are kept)`,
    );
  // An existing secrets file may also hold source keys: never rewrite it.
  const hasSecrets = await exists(files.secrets);
  const kept = await existingSecrets(files.secrets);
  if (hasSecrets && (!kept.token || !kept.consent))
    throw new UsageError(
      `${files.secrets} needs MGMT_TOKEN and CONSENT_SECRET lines; add them or move the file aside`,
    );
  const token = kept.token ?? newSecret();
  const consent = kept.consent ?? newSecret();
  const state = await existingState(files.state);
  if (state?.token && state.token !== token)
    throw new UsageError(
      `${files.state} holds another management token; move it aside to set up this server`,
    );
  const server = {
    ...(options.local ? { local: true } : {}),
    host: "127.0.0.1",
    port: options.local ? Number(address.port || 80) : 8787,
    // A trial runs the build this CLI is part of; a server runs a release.
    app: options.local
      ? path.dirname(deps.templateDir)
      : path.join(base, "current", "dist"),
    state: path.join(base, "state"),
    secretsFile: "secrets.env",
    cronUtc: "02:00",
    vars: {
      ...(await deploymentVars(config, deps.cwd)),
      PUBLIC_URL: publicUrl,
      WRITE_LIMIT: serverWriteLimit,
    },
  };
  const written = [files.server, files.secrets, files.state];
  if (options.dryRun)
    return {
      dryRun: true,
      base,
      files: written,
      keepsSecrets: hasSecrets,
      vars: Object.keys(server.vars).sort(),
    };
  for (const folder of folders) {
    await mkdir(path.join(base, folder), { recursive: true, mode: 0o700 });
    await chmod(path.join(base, folder), 0o700);
  }
  if (await exists(files.server))
    await rename(files.server, `${files.server}.before-init-${Date.now()}`);
  await privateJson(files.server, server);
  if (!hasSecrets)
    await privateText(
      files.secrets,
      `MGMT_TOKEN=${token}\nCONSENT_SECRET=${consent}\n`,
    );
  await mkdir(deps.dir, { recursive: true, mode: 0o700 });
  if (await exists(files.state))
    await rename(files.state, `${files.state}.bak`);
  await privateJson(files.state, {
    name: "litscout",
    token,
    consentSecret: consent,
    endpoint: publicUrl,
  });
  return { dryRun: false, base, files: written, keepsSecrets: hasSecrets };
}
