import { prepareConsentAction } from "../../consent/operations";
import { EmailForwardingAddress } from "../../../src/core/ingestion/contract";
import { Effect, Option, Schema } from "effect";
import { dailyAuditExhausted, refusedByAuditBudget } from "../../../src/shell/audit/operations";
import { forwardingAddressAudit, forwardingAddressGuardAudit } from "./forwarding-address";
import {
  callerScope,
  failedPreparation,
  refusedPreparation,
  transactionFailure,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  type CanonicalMutationRefusal,
  type CanonicalPreparationWork,
  type CommittedMutationValue,
  type GuardRefusalWork,
} from "../../canonical-operations/contract";

/** Keep a commit-time forwarding Audit refusal on its existing unavailable response path. */
export const forwardingAuditLimitRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily canonical work budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(transactionUnavailable()),
});

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

const forwardingAddressGuardRefusal = ({
  db,
  subject,
  current,
}: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> =>
  Effect.succeed({
    code: "validation_failed",
    message: "The forwarding address could not complete its guarded write.",
    record: () =>
      Effect.tryPromise(() => forwardingAddressGuardAudit({ db, subject, current }).run()).pipe(
        Effect.map((result) =>
          result.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
        ),
        Effect.catch((cause) =>
          Effect.succeed(
            refusedByAuditBudget(cause) ? ("rate_limited" as const) : ("unavailable" as const)
          )
        )
      ),
    respond: () =>
      Effect.succeed(
        transactionFailure({
          code: "validation_failed",
          status: 400,
          message: "The forwarding address could not complete its guarded write.",
        })
      ),
  });

/** Prepare the issued address without a nested D1 unit, for individual calls and atomic batches. */
export const prepareForwardingAddress = Effect.fn(function* (work: CanonicalPreparationWork) {
  const existing = yield* Effect.tryPromise(() =>
    prepareConsentAction({
      db: work.db,
      subject: { _tag: "User", userId: work.subject.userId },
      requirement: "active",
      statement: {
        sql: "SELECT id FROM email_forwarding_addresses WHERE user_id = ?",
        params: [work.subject.userId],
      },
    }).first()
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
      oauthReview: Option.none(),
      requiredScope: callerScope(work.subject),
      guardRefusal: forwardingAddressGuardRefusal,
      auditBudget: "shared",
      commitGuards: Option.none(),
      statements: forwardingAddressAudit({
        db: work.db,
        subject: work.subject,
        current: work.current,
        operation: "ingestion.enableEmailForwarding",
      }),
      outcome: {
        _tag: "ForwardingAddress",
        operation: "ingestion.enableEmailForwarding",
        current: work.current,
      },
    },
  } as const;
});

/** The issued address is immutable; enabling it is an audited, composable idempotent mutation. */
export const forwardingAddressMutationAdapter = {
  prepare: prepareForwardingAddress,
  present: (value: CommittedMutationValue): Effect.Effect<Response> =>
    value._tag === "ForwardingAddress"
      ? Schema.encodeEffect(Schema.toCodecJson(EmailForwardingAddress))(value.address).pipe(
          Effect.map((data) => Response.json({ data, next: [] }, { headers: transactionNoStore })),
          Effect.orElseSucceed(transactionUnavailable)
        )
      : Effect.succeed(transactionUnavailable()),
  invalidRefusal: (_work: CanonicalPreparationWork): CanonicalMutationRefusal => ({
    code: "validation_failed",
    message: "Invalid forwarding address call.",
    record: () => Effect.succeed("recorded" as const),
    respond: () => Effect.succeed(transactionUnavailable()),
  }),
};
