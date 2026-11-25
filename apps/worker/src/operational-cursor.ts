const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const fulltextName = /^fulltext:\d{4}-\d{2}-\d{2}$/;
const legacyName = /^legacy:[a-f0-9]{32}$/;
function day(value: unknown) {
  if (typeof value !== "string" || !dayPattern.test(value)) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
function id(value: unknown, prefix: string) {
  return (
    typeof value === "string" && value.length <= 128 && value.startsWith(prefix)
  );
}
function optionalDays(value: unknown) {
  return (
    value === undefined ||
    (Array.isArray(value) && value.length <= 60 && value.every(day))
  );
}
/** Preserve the small operational-state allowlist without an outgoing Zod walk. */
export function isOperationalCursor(name: string, value: string) {
  if (value.length > 2048) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return false;
  }
  if (fulltextName.test(name))
    return (
      Array.isArray(raw) && raw.length <= 2 && raw.every((v) => id(v, "pap_"))
    );
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const data = raw as Record<string, unknown>,
    keys = Object.keys(data);
  if (name === "venue-feed") return keys.length === 1 && day(data.since);
  if (name === "arxiv-listing")
    return (
      keys.every((k) =>
        ["listingDate", "runDay", "noAnnouncement", "pendingDays"].includes(k),
      ) &&
      day(data.listingDate) &&
      day(data.runDay) &&
      optionalDays(data.noAnnouncement) &&
      optionalDays(data.pendingDays)
    );
  if (legacyName.test(name))
    return (
      keys.every((k) => ["offset", "runId", "version"].includes(k)) &&
      (data.version === undefined || data.version === 2) &&
      typeof data.offset === "number" &&
      Number.isInteger(data.offset) &&
      data.offset >= 0 &&
      data.offset <= 1000000 &&
      (data.runId === undefined || id(data.runId, "run_"))
    );
  return false;
}
