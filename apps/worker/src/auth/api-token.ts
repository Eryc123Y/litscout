import { drizzle } from "drizzle-orm/d1";
import { findApiToken } from "@litscout/db";
import { digest } from "./crypto";

export const apiTokenBearer = /^Bearer lsk_[A-Z2-7]{52}$/;

export async function readApiToken(db: D1Database, bearer: string) {
  return findApiToken(
    drizzle(db),
    await digest(bearer.slice("Bearer ".length)),
  );
}
