import { afterAll, beforeAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { webRuntime } from "./helpers/web-runtime";
import { normaliseUrl } from "../src/request-path";

const day = "2026-11-17";
const doi = "10.1109/tvcg.2026.3747406";
const arxiv = "2611.08639";
let runtime: Miniflare;
beforeAll(async () => {
  runtime = await webRuntime({ localDev: true });
}, 30_000);
afterAll(async () => runtime?.dispose());

it("resolves encoded qualified and bare identifiers through the real Worker entry point", async () => {
  const db = await runtime.getD1Database("DB");
  for (const [scheme, value, source] of [
    ["doi", doi, "journal"],
    ["arxiv", arxiv, "arxiv"],
  ] as const) {
    const stored = await db
      .prepare("SELECT paper_id FROM paper_ids WHERE scheme=? AND value=?")
      .bind(scheme, value)
      .first<{ paper_id: string }>();
    expect(stored).not.toBeNull();
    for (const prefix of ["/papers", "/public/papers"]) {
      for (const id of [stored!.paper_id, value, `${scheme}:${value}`]) {
        for (const query of ["", `?day=${day}&source=${source}`]) {
          const response = await runtime.dispatchFetch(
            `http://local/api/v1${prefix}/${encodeURIComponent(id)}${query}`,
          );
          expect(
            response.status,
            `${prefix}/${id}${query}: ${await response.clone().text()}`,
          ).toBe(200);
          const body = await response.json();
          expect(body).toMatchObject({
            success: true,
            data: {
              paperId: stored!.paper_id,
              source,
              identifiers: [{ scheme, value }],
            },
          });
          if (prefix.startsWith("/public"))
            expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|"readingState"/);
        }
      }
    }
  }
});

it("allows an encoded slash only inside the exact paper-id path segment", () => {
  for (const prefix of ["/api/v1/papers/", "/api/v1/public/papers/"]) {
    const url = `https://worker.example${prefix}${encodeURIComponent(`doi:${doi}`)}?day=${day}&source=journal`;
    expect(normaliseUrl(url)).toBe(url);
  }
  for (const path of [
    "/%2Fapp/x",
    "/app%2Fx",
    "/api%2Fv1/public/papers/id",
    "/api/v1/public/papers%2Fid",
    "/api/v1/public/papers/id/extra%2Fpart",
    "/api/v1/public/papers/..%2Fadmin",
    "/api/v1/papers/id%5Cpart",
    "/api/v1/public/papers/%zz",
  ])
    expect(() => normaliseUrl(`https://worker.example${path}`), path).toThrow();
});
