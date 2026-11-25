import { invalidJson } from "./api-errors";
import { apiJson } from "./api-response";
import type { MiddlewareHandler } from "hono";
import type { WorkerBindings } from "./api-auth";
import { vaultWriteReservation } from "@litscout/pipeline/vault-contracts";
import {
  trendsUploadBytes,
  trendsUploadPath,
} from "@litscout/pipeline/trends-contracts";
import { zoteroImportPath } from "@litscout/pipeline/zotero-contracts";
import { INGEST_CAPS } from "@litscout/core/ingest-limits";
/** Bound discarded bytes; no decoding, concatenation or JSON work after the cap. */
export const DRAIN_CEILING = 2 * 1024 * 1024;
export const requestSize: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  const ingest =
    c.req.path.startsWith("/api/v1/ingest/") ||
    (c.req.method === "PUT" && /^\/api\/v1\/digests\/[^/]+$/.test(c.req.path));
  const vaultWrite =
    !["GET", "HEAD"].includes(c.req.method) &&
    vaultWriteReservation(c.req.path.replace(/^\/api\/v1/, ""), undefined) > 0;
  const maximum =
    c.req.path === "/api/v1" + trendsUploadPath
      ? trendsUploadBytes
      : ingest || c.req.path === "/api/v1" + zoteroImportPath
        ? INGEST_CAPS.bytes
        : 1024 * 1024;
  const reject = (message = `Request body exceeds ${maximum} bytes`) =>
    apiJson(
      c,
      {
        success: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message,
        },
      },
      413,
    );
  if (Number(c.req.header("content-length")) > maximum) return reject();
  const reader = c.req.raw.body?.getReader();
  if (!reader) {
    if (vaultWrite) c.set("ingestBody", {});
    return next();
  }
  const chunks: Uint8Array[] = [],
    limit = { bytes: 0 };
  let oversized = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    limit.bytes += value.byteLength;
    if (limit.bytes > maximum) {
      if (!oversized) {
        oversized = true;
        chunks.length = 0;
      }
      if (limit.bytes > DRAIN_CEILING) {
        await reader.cancel().catch(() => {});
        return reject();
      }
      continue;
    }
    chunks.push(value);
  }
  if (oversized) return reject();
  const buffer = new Uint8Array(limit.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  c.req.raw = new Request(c.req.raw, { body: buffer });
  if (vaultWrite) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      c.set("ingestBody", buffer.byteLength ? JSON.parse(text) : {});
    } catch {
      return invalidJson(c);
    }
  }
  if (ingest) {
    const value: unknown = await c.req.json();
    c.set("ingestBody", value);
    if (value && typeof value === "object") {
      const body = value as Record<string, unknown>;
      const kind = c.req.path.split("/").at(-1)!;
      const keys =
        kind === "legacy"
          ? ["cursors", "runs", "missed", "ratings"]
          : kind === "alphaxiv"
            ? ["items"]
            : [kind];
      const cap =
        kind === "alphaxiv"
          ? INGEST_CAPS.papers
          : INGEST_CAPS[kind as keyof typeof INGEST_CAPS];
      if (
        cap &&
        keys.reduce(
          (n, key) => n + (Array.isArray(body[key]) ? body[key].length : 0),
          0,
        ) > cap
      )
        return reject(`Ingest ${kind} exceeds ${cap} records per request`);
    }
  }
  await next();
};
