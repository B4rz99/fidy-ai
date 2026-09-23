import { Clock, Effect } from "effect";

/** Shared, request-scoped identity and safe response vocabulary for the two D1 Transaction adapters. */
export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
// @effect-diagnostics-next-line cryptoRandomUUID:off
export const transactionId = (): string => crypto.randomUUID();
export const transactionNoStore = { "cache-control": "no-store" };
const utcDayMilliseconds = 86_400_000;
// Matches the 256-entry stable-User trigger in 0009_transactions.sql; the trigger remains the
// atomic authority if concurrent requests pass this cheap preflight together.
const lastAdmissibleAuditOffset = 255;
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const transactionAuditExhausted = async (
  db: D1Database,
  userId: string,
  current: number
): Promise<boolean> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  const row = await db
    .prepare(`SELECT id FROM transaction_audit WHERE user_id = ?
    AND occurred_at_ms >= ? AND occurred_at_ms < ? LIMIT 1 OFFSET ?`)
    .bind(userId, start, start + utcDayMilliseconds, lastAdmissibleAuditOffset)
    .first();
  return row !== null;
};
export const transactionUnavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: transactionNoStore });

// @effect-diagnostics-next-line missingPipeableSignature:off
export const transactionFailure = (
  code: "unauthenticated" | "validation_failed" | "not_found" | "rate_limited",
  status: number,
  message: string
): Response =>
  Response.json(
    { error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) }, next: [] },
    { status, headers: transactionNoStore }
  );
