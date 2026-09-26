import { EmailForwardingAddress } from "../../src/core/ingestion/model";
import { Effect, Option, Schema } from "effect";
import { dailyAuditExhausted } from "../atomic/daily-canonical-budget";
import { forwardingAddressAudit } from "../ingestion/forwarding-address";
import { statementSubmissionCompletion } from "../ingestion/statement-staging";
import {
  callerScope,
  transactionNoStore,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import type { CanonicalMutationAdapter } from "./canonical-mutation-registry";
import {
  type CanonicalMutationRefusal,
  failedPreparation,
  refusedPreparation,
} from "./mutation-types";

const limited = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily canonical work budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () =>
    Effect.succeed(
      Response.json(
        {
          error: { code: "rate_limited", message: "Daily canonical work budget exhausted." },
          next: [],
        },
        { status: 429, headers: transactionNoStore }
      )
    ),
});

/** Prepare the issued address without a nested D1 unit, for individual calls and atomic batches. */
export const prepareForwardingAddress = Effect.fn(function* (
  work: Parameters<CanonicalMutationAdapter["prepare"]>[0]
) {
  const existing = yield* Effect.tryPromise(() =>
    work.db
      .prepare(
        `SELECT id FROM email_forwarding_addresses WHERE user_id = ? AND
       EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = ?) AND
       NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?)`
      )
      .bind(work.subject.userId, work.subject.userId, work.subject.userId)
      .first()
  ).pipe(Effect.option);
  if (Option.isNone(existing) || existing.value === null) return failedPreparation();
  const exhausted = yield* Effect.tryPromise(() =>
    dailyAuditExhausted({
      db: work.db,
      userId: work.subject.userId,
      current: work.current,
    })
  ).pipe(Effect.option);
  if (Option.isNone(exhausted)) return failedPreparation();
  if (exhausted.value) return refusedPreparation(limited());
  return {
    _tag: "Prepared",
    mutation: {
      requiredScope: callerScope(work.subject),
      statements: forwardingAddressAudit({
        db: work.db,
        subject: work.subject,
        current: work.current,
        operation: "ingestion.enableEmailForwarding",
      }),
      completion: work.db.prepare(statementSubmissionCompletion),
      outcome: { _tag: "ForwardingAddress", current: work.current },
    },
  } as const;
});

/** The issued address is immutable; enabling it is an audited, composable idempotent mutation. */
export const forwardingAddressMutationAdapter: CanonicalMutationAdapter = {
  prepare: prepareForwardingAddress,
  present: (value) =>
    value._tag === "ForwardingAddress"
      ? Schema.encodeEffect(Schema.toCodecJson(EmailForwardingAddress))(value.address).pipe(
          Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
          Effect.orElseSucceed(transactionUnavailable)
        )
      : Effect.succeed(transactionUnavailable()),
  invalidRefusal: () => ({
    code: "validation_failed",
    message: "Invalid forwarding address call.",
    record: () => Effect.succeed("recorded" as const),
    respond: () => Effect.succeed(transactionUnavailable()),
  }),
};
