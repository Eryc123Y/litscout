import { createLogger } from "@litscout/core";
const logger = createLogger("warn", (entry) =>
  console.warn(JSON.stringify(entry)),
);
/** Log configuration field names/reasons only, never environment values or requests. */
export function unavailable(reason: string): Response {
  logger.error("Service unavailable", { reason });
  return Response.json(
    {
      success: false,
      error: { code: "UNAVAILABLE", message: "Service unavailable" },
    },
    { status: 503 },
  );
}

/** Pick only the approved error fields, never the request object or error stack. */
export function logRequestError(error: Error, path: string): void {
  logger.error("Request failed", {
    name: error.name,
    message: error.message,
    path,
  });
}
