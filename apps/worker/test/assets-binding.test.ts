import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
let assetsDir: string;
let runtime: Miniflare;
let jwt: string;
async function createAssetFiles() {
  assetsDir = await mkdtemp(path.join(tmpdir(), "litscout-assets-"));
  await mkdir(path.join(assetsDir, "assets"));
  await mkdir(path.join(assetsDir, "public"));
  await writeFile(
    path.join(assetsDir, "index.html"),
    "<!doctype html><title>Real LitScout asset</title>",
  );
  await writeFile(
    path.join(assetsDir, "assets", "example.txt"),
    "real bundled asset",
  );
  await writeFile(
    path.join(assetsDir, "public", "example.txt"),
    "real public asset",
  );
  await writeFile(path.join(assetsDir, "hidden.txt"), "must remain private");
}
async function compileWorker() {
  await build({
    stdin: {
      contents: `import worker from "./apps/worker/src/index.ts";
 export default {async fetch(request,env,ctx){
  if(new URL(request.url).pathname==="/__asset_probe"){
   const response=await env.ASSETS.fetch(new URL("/assets/example.txt",request.url));
   try{response.headers.set("x-probe","mutation");return Response.json({immutable:false});}
   catch(error){return Response.json({immutable:true,name:error.name,message:error.message});}
  }
  return worker.fetch(request,env,ctx);
 }};`,
      resolveDir: process.cwd(),
      sourcefile: "assets-test-entry.ts",
    },
    outfile: ".artifacts/assets-binding-worker.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: JSON.stringify("assets-test") },
  });
}
function assetsRuntime(jwk: unknown) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".artifacts/assets-binding-worker.js",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      assets: {
        directory: assetsDir,
        binding: "ASSETS",
        run_worker_first: true,
        routerConfig: { has_user_worker: true },
      },
      bindings: {
        PUBLIC_URL: "https://worker.example",
        ACCESS_TEAM_DOMAIN: "asset-team.example",
        ACCESS_AUD: "asset-audience",
      },
      outboundService: () => Response.json({ keys: [jwk] }),
    }),
  );
}
beforeAll(async () => {
  await createAssetFiles();
  await compileWorker();
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "assets", alg: "RS256" };
  jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "assets" })
    .setIssuer("https://asset-team.example")
    .setAudience("asset-audience")
    .setExpirationTime("5m")
    .sign(privateKey);
  runtime = assetsRuntime(jwk);
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  if (assetsDir) await rm(assetsDir, { recursive: true, force: true });
});
const request = (pathname: string, authenticated = false) =>
  runtime.dispatchFetch("https://worker.example" + pathname, {
    redirect: "manual",
    headers: authenticated ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
it("proves the actual binding returns immutable response headers", async () => {
  const response = await request("/__asset_probe");
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    immutable: true,
    name: "TypeError",
    message: expect.stringMatching(/immutable/i),
  });
});
it.each([
  ["/", "Real LitScout asset", false],
  ["/assets/example.txt", "real bundled asset", false],
  ["/public/example.txt", "real public asset", false],
  ["/app/x", "Real LitScout asset", true],
] as const)(
  "serves real assets with security headers at %s",
  async (pathname, content, authenticated) => {
    const response = await request(pathname, authenticated);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(content);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  },
);
it("retains the private-route check and denies unlisted files", async () => {
  expect((await request("/app/x")).status).toBe(401);
  expect((await request("/hidden.txt")).status).toBe(404);
});
