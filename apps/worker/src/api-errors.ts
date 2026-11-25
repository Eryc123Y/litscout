import { apiJson } from "./api-response";
import type { Context } from "hono";
import { z } from "zod";
import {
  FinalDigestConflict,
  SummaryCounterConflict,
  UnknownSuggestionIdea,
} from "@litscout/db/ingest";
import { CorruptBackupRow } from "@litscout/db/backup";
import type { WorkerBindings } from "./api-auth";
import { PaperMergeConflict } from "@litscout/db/ingest-papers";
import { quotaResponse, WriteQuotaError } from "./write-quota";
export function knownApiError(error: Error, c: Context<WorkerBindings>) {
  if (error instanceof WriteQuotaError) return quotaResponse(c, error.needed);
  if (
    c.req.path.startsWith("/api/v1/public/") &&
    (error instanceof z.ZodError || error instanceof SyntaxError)
  )
    return apiJson(
      c,
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "Invalid input" },
      },
      400,
    );
  if (error instanceof CorruptBackupRow)
    return apiJson(
      c,
      {
        success: false,
        error: { code: "CORRUPT_BACKUP_ROW", message: error.message },
      },
      500,
    );
  if (error instanceof z.ZodError) return validationError(error, c);
  if (error instanceof SyntaxError) return invalidJson(c);
  if (
    error instanceof SummaryCounterConflict ||
    error instanceof PaperMergeConflict
  )
    return apiJson(
      c,
      { success: false, error: { code: "CONFLICT", message: error.message } },
      409,
    );
  if (error instanceof UnknownSuggestionIdea)
    return apiJson(
      c,
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: error.message },
      },
      400,
    );
  if (error instanceof FinalDigestConflict)
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "CONFLICT",
          message: "Final digest requires write scope",
        },
        meta: { rowsWritten: error.rowsWritten },
      },
      409,
    );
  if (error.message === "IDENTITY_CONFLICT")
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "CONFLICT",
          message:
            "Identifiers refer to different papers; resolve the identity first",
        },
      },
      409,
    );
  return null;
}

function validationError(error: z.ZodError, c: Context<WorkerBindings>) {
  return apiJson(
    c,
    {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid input",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    },
    400,
  );
}

export function invalidJson(c: Context<WorkerBindings>) {
  return apiJson(
    c,
    {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid JSON" },
    },
    400,
  );
}
