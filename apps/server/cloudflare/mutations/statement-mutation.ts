import { SubmitForExtractionCanonicalInput } from "@fidy/server/canonical-runtime";
import { StatementSubmission } from "@fidy/server/statement-staging";
import { Effect, Option, Schema } from "effect";
import { dailyAuditExhausted } from "../atomic/daily-canonical-budget";
import type { AtomicMutationRefusal } from "../atomic/atomic-mutation-unit";
import { statementRefusalResponse } from "../ingestion/statement-ingestion";
import {
  type StatementStagingConfig,
  prepareStagedStatementPublication,
  recordStatementRefusal,
  statementRefusal,
  statementSubmissionCompletion,
} from "../ingestion/statement-staging";
import {
  callerAuthority,
  callerScope,
  transactionNoStore,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "./mutation-types";
import type { CanonicalMutationAdapter } from "./canonical-mutation-registry";

const StatementInput = Schema.toType(SubmitForExtractionCanonicalInput);
const dailyBudgetMessage = "Too many statement calls today; retry after the daily budget resets.";
const dailyBudgetResponse = (): Response =>
  Response.json(
    { error: { code: "rate_limited", message: dailyBudgetMessage }, next: [] },
    { status: 429, headers: transactionNoStore }
  );
const dailyBudgetRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: dailyBudgetMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(dailyBudgetResponse()),
});

/** Preserve the statement owner's metadata-only refusal audit and individual response. */
export const canonicalStatementRefusal = ({
  config,
  subject,
  current,
  refusal,
}: Readonly<{
  config: StatementStagingConfig;
  subject: Parameters<typeof callerAuthority>[0]["subject"];
  current: number;
  refusal: AtomicMutationRefusal;
}>): CanonicalMutationRefusal => ({
  code: refusal.code,
  message: refusal.message,
  record: () =>
    Effect.tryPromise(() =>
      recordStatementRefusal({
        authority: callerAuthority({ subject, current }),
        current,
        database: config.database,
        refusal,
      })
    ).pipe(Effect.orElseSucceed(() => "unavailable" as const)),
  respond: (disposition) => {
    if (disposition === "recorded") return Effect.succeed(statementRefusalResponse(refusal));
    if (disposition === "rate_limited") return Effect.succeed(dailyBudgetResponse());
    return Effect.succeed(transactionUnavailable());
  },
});

/** One staged reference prepared for the shared canonical mutation unit, never a nested commit. */
export const statementMutationAdapter: CanonicalMutationAdapter = {
  prepare: (work) =>
    Effect.gen(function* () {
      if (Option.isNone(work.bucket)) return unavailablePreparation();
      const config: StatementStagingConfig = {
        database: work.db,
        bucket: work.bucket.value,
        nowEpochMs: () => work.current,
      };
      const parsed = Schema.decodeUnknownOption(StatementInput)(work.input);
      if (Option.isNone(parsed)) return failedPreparation();
      const spent = yield* Effect.tryPromise(() =>
        dailyAuditExhausted({ db: work.db, userId: work.subject.userId, current: work.current })
      ).pipe(Effect.option);
      if (Option.isNone(spent)) return failedPreparation();
      if (spent.value) {
        return refusedPreparation(dailyBudgetRefusal());
      }
      const prepared = yield* prepareStagedStatementPublication(config, {
        authority: callerAuthority({ subject: work.subject, current: work.current }),
        current: work.current,
        idempotencyKey: parsed.value.payload.idempotencyKey,
        reference: parsed.value.payload.reference,
        userId: work.subject.userId,
      }).pipe(Effect.option);
      if (Option.isNone(prepared)) return unavailablePreparation();
      if (prepared.value._tag === "Unavailable") return unavailablePreparation();
      if (prepared.value._tag === "Refused") {
        return refusedPreparation(
          canonicalStatementRefusal({
            config,
            subject: work.subject,
            current: work.current,
            refusal: statementRefusal(prepared.value.reason),
          })
        );
      }
      const publication = prepared.value.publication;
      return {
        _tag: "Prepared",
        mutation: {
          requiredScope: callerScope(work.subject),
          statements: publication.statements,
          completion: work.db.prepare(statementSubmissionCompletion),
          outcome: { _tag: "StatementSubmission", publication, config },
        },
      } as const satisfies CanonicalMutationPreparation;
    }),
  present: (value) =>
    value._tag === "StatementSubmission"
      ? Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(value.submission).pipe(
          Effect.map((data) =>
            Response.json({ data, next: [] }, { status: 202, headers: transactionNoStore })
          ),
          Effect.orElseSucceed(transactionUnavailable)
        )
      : Effect.succeed(transactionUnavailable()),
  invalidRefusal: (work) => {
    if (Option.isNone(work.bucket)) {
      return {
        code: "unavailable",
        message: "Statement staging is unavailable.",
        record: () => Effect.succeed("unavailable" as const),
        respond: () => Effect.succeed(transactionUnavailable()),
      };
    }
    return canonicalStatementRefusal({
      config: { database: work.db, bucket: work.bucket.value, nowEpochMs: () => work.current },
      subject: work.subject,
      current: work.current,
      refusal: statementRefusal("malformed-file"),
    });
  },
};
