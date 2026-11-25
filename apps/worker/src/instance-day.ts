import { instanceInfo } from "./public-feed";
import type { AppEnv } from "./env";
export const userDay = (env: AppEnv, now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: instanceInfo(env).timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
