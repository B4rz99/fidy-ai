import { Clock, Effect } from "effect";
import { newId } from "./pat-shared";

/** Shared, request-scoped identity and safe response vocabulary for the two D1 Transaction adapters. */
export type TransactionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
export const transactionNow = (): number => Effect.runSync(Clock.currentTimeMillis);
export const transactionId = (): string => newId();
export const transactionNoStore = { "cache-control": "no-store" };
const utcDayMilliseconds = 86_400_000;
// Matches the 256-entry stable-User triggers in 0010_pat_lifecycle.sql. These remain the
// atomic authority if concurrent browser and PAT requests pass this cheap preflight together.
const lastAdmissibleAuditOffset = 255;
export const transactionAuditExhausted = ({
  db,
  userId,
  current,
}: Readonly<{ db: D1Database; userId: string; current: number }>): Promise<boolean> => {
  const start = Math.floor(current / utcDayMilliseconds) * utcDayMilliseconds;
  return db
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
    .first()
    .then((row) => row !== null);
};
export const transactionUnavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: transactionNoStore });

export const transactionFailure = ({
  code,
  status,
  message,
}: Readonly<{
  code:
    | "unauthenticated"
    | "validation_failed"
    | "not_found"
    | "rate_limited"
    | "user_action_required";
  status: number;
  message: string;
}>): Response =>
  Response.json(
    { error: { code, message, ...(code === "validation_failed" ? { fields: [] } : {}) }, next: [] },
    { status, headers: transactionNoStore }
  );

/** Classify a PAT protected-work refusal after re-reading the current User Consent decision. */
const HTTP_UNAUTHENTICATED = 401;
const HTTP_ACTION_REQUIRED = 403;
export const refusedPATWork = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Promise<Response> =>
  Effect.tryPromise({
    try: () =>
      db.prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?").bind(userId).first(),
    catch: () => undefined,
  }).pipe(
    Effect.map((withdrawn) =>
      withdrawn === null
        ? transactionFailure({
            code: "unauthenticated",
            status: HTTP_UNAUTHENTICATED,
            message: "Present a valid credential and retry.",
          })
        : transactionFailure({
            code: "user_action_required",
            status: HTTP_ACTION_REQUIRED,
            message: "Return to Fidy to review your withdrawn Consent.",
          })
    ),
    Effect.runPromise
  );
