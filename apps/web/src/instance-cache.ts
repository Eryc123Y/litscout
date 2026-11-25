import { instanceSchema } from "@litscout/pipeline/web-contracts";
import type { InstanceInfo } from "@litscout/pipeline/web-contracts";

const key = "litscout.instance";

/** The instance info this browser saw last (name, language, time zone,
 * topics): the page starts from it instead of waiting on the request, and
 * the answer replaces it. Nothing private is in it. */
export function readCachedInstance(): InstanceInfo | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (!stored) return undefined;
    const parsed = instanceSchema.strict().safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveCachedInstance(instance: InstanceInfo) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(instance));
  } catch {
    // A blocked store only means the next visit waits for the request.
  }
}
