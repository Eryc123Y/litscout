import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "../env";
import { constantTimeEqual, digest, pairingCode } from "./crypto";

const requestLimitWindow = z.union([
  z.literal("minute"),
  z.literal("utc-day"),
  z.number().int().min(1).max(600),
]);
type RequestLimitWindow = z.infer<typeof requestLimitWindow>;

interface PairingState {
  hash: string;
  expiresAt: number;
  attempts: Record<string, number>;
}
export interface ApprovedClient {
  clientId: string;
  authorizationId: string;
  approvedAt: number;
}
/** Durable storage transactions serialize all code checks, including after eviction. */
export class PairingStore extends DurableObject<AppEnv> {
  async create(): Promise<{ code: string; expiresAt: number }> {
    const code = pairingCode();
    const expiresAt = Date.now() + 600_000;
    await this.ctx.storage.put("pairing", {
      hash: await digest(code),
      expiresAt,
      attempts: {},
    });
    return { code, expiresAt };
  }
  async consume(
    code: string,
    clientId: string,
    handle = clientId,
  ): Promise<string | null> {
    const scope = await digest(z.string().max(8192).parse(handle));
    const hash = await digest(code.trim().toUpperCase());
    return this.ctx.storage.transaction(async (txn) => {
      const state = await txn.get<PairingState>("pairing");
      if (
        !state ||
        state.expiresAt <= Date.now() ||
        (state.attempts[scope] ?? 0) >= 5
      )
        return null;
      if (!(await constantTimeEqual(hash, state.hash))) {
        await txn.put("pairing", {
          ...state,
          attempts: {
            ...state.attempts,
            [scope]: (state.attempts[scope] ?? 0) + 1,
          },
        });
        return null;
      }
      await txn.delete("pairing");
      const authorizationId = crypto.randomUUID();
      const clients = (await txn.get<ApprovedClient[]>("clients")) ?? [];
      await txn.put("clients", [
        ...clients,
        { clientId, authorizationId, approvedAt: Date.now() },
      ]);
      return authorizationId;
    });
  }
  async allowRequest(
    limit: number,
    window: RequestLimitWindow = "minute",
    count = true,
  ) {
    requestLimitWindow.parse(window);
    z.number()
      .int()
      .min(1)
      .max(window === "utc-day" ? 5000 : 300)
      .parse(limit);
    return this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const previous = await txn.get<{ count: number; expiresAt: number }>(
        "http-limit",
      );
      const state =
        previous && previous.expiresAt > now
          ? previous
          : {
              count: 0,
              expiresAt:
                window === "utc-day"
                  ? new Date(now).setUTCHours(24, 0, 0, 0)
                  : now + (window === "minute" ? 60 : window) * 1000,
            };
      if (state.count >= limit)
        return {
          allowed: false,
          retryAfter: Math.max(1, Math.ceil((state.expiresAt - now) / 1000)),
        };
      if (count)
        await txn.put("http-limit", { ...state, count: state.count + 1 });
      return { allowed: true, retryAfter: 0 };
    });
  }
  async clients(): Promise<ApprovedClient[]> {
    return (await this.ctx.storage.get<ApprovedClient[]>("clients")) ?? [];
  }
  async isActive(authorizationId: string): Promise<boolean> {
    return (await this.clients()).some(
      (client) => client.authorizationId === authorizationId,
    );
  }
  async revoke(clientId: string): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const clients = (await txn.get<ApprovedClient[]>("clients")) ?? [];
      await txn.put(
        "clients",
        clients.filter((client) => client.clientId !== clientId),
      );
    });
  }
}
export function pairingStore(env: AppEnv): DurableObjectStub<PairingStore> {
  return env.PAIRING_STORE.get(env.PAIRING_STORE.idFromName("owner"));
}
