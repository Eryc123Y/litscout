/** Never display upstream messages, argv, headers, bodies, or account identifiers. */
export function operationalReason(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth++
  ) {
    if (current instanceof DOMException && current.name === "TimeoutError")
      return "request timed out";
    const value = current as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const status = value.status ?? value.statusCode;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    )
      return `HTTP ${status}`;
    if (typeof value.code === "number" && Number.isInteger(value.code))
      return `error code ${value.code}`;
    if (
      typeof value.code === "string" &&
      /^(?:E(?:ACCES|PERM|NOENT|XIST|CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)|ERR_[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(
        value.code,
      )
    )
      return `error code ${value.code}`;
    current = value.cause;
  }
  return "error code unavailable";
}
