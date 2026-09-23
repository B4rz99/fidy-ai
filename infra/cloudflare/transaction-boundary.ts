import { Clock, Effect } from "effect";

/** Shared, request-scoped identity and safe response vocabulary for the two D1 Transaction adapters. */
export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
// @effect-diagnostics-next-line cryptoRandomUUID:off
export const transactionId = (): string => crypto.randomUUID();
export const transactionNoStore = { "cache-control": "no-store" };
const utcDayMilliseconds = 86_400_000;
// Matches the 256-entry stable-User triggers in 0014_canonical_category_budget.sql. These remain the
// atomic authority if concurrent browser and PAT requests pass this cheap preflight together.
const lastAdmissibleAuditOffset = 255;
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const transactionAuditExhausted = async (
  db: D1Database,
  userId: string,
  current: number
): Promise<boolean> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  const row = await db
    .prepare(`SELECT 1 FROM (
      SELECT occurred_at_ms FROM transaction_audit WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM pat_audit WHERE user_id = ?
      AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
      UNION ALL
      SELECT occurred_at_ms FROM category_audit WHERE user_id = ?
      AND occurred_at_ms >= ? AND occurred_at_ms < ?
    ) LIMIT 1 OFFSET ?`)
    .bind(
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      userId,
      start,
      start + utcDayMilliseconds,
      lastAdmissibleAuditOffset
    )
    .first();
  return row !== null;
};
export const transactionUnavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: transactionNoStore });

// @effect-diagnostics-next-line missingPipeableSignature:off
export const transactionFailure = (
  code:
    | "unauthenticated"
    | "validation_failed"
    | "not_found"
    | "rate_limited"
    | "user_action_required",
  status: number,
  message: string
): Response =>
  Response.json(
    { error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) }, next: [] },
    { status, headers: transactionNoStore }
  );

/** Classify a PAT protected-work refusal after re-reading the current User Consent decision. */
const HTTP_UNAUTHENTICATED = 401;
const HTTP_ACTION_REQUIRED = 403;
export const refusedPATWork = async (db: D1Database, userId: string): Promise<Response> => {
  const withdrawn = await db
    .prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?")
    .bind(userId)
    .first();
  return withdrawn === null
    ? transactionFailure(
        "unauthenticated",
        HTTP_UNAUTHENTICATED,
        "Present a valid credential and retry."
      )
    : transactionFailure(
        "user_action_required",
        HTTP_ACTION_REQUIRED,
        "Return to Fidy to review your withdrawn Consent."
      );
};
