import { getCanonicalOperationInput } from "@fidy/server/canonical-runtime";
import { StatementSubmission } from "@fidy/server/statement-staging";
import { Effect, Option, Schema } from "effect";
import { dailyAuditExhausted } from "../atomic/daily-canonical-budget";
import type { StatementPublicationRefusal } from "../ingestion/statement-staging";
import {
  statementDailyBudgetMessage,
  statementDailyBudgetResponse,
  statementRefusalResponse,
} from "../ingestion/statement-ingestion";
import {
  type PreparedStatementPublication,
  type StatementStagingConfig,
  prepareStagedStatementPublication,
  recordStatementRefusal,
  statementAbortRefusal,
  statementRefusal,
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
  type GuardRefusalWork,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "./mutation-types";
import type { CanonicalMutationAdapter } from "./canonical-mutation-registry";

const StatementInput = Schema.toType(getCanonicalOperationInput("ingestion.submitForExtraction"));
/** One statement-owned budget policy; a trigger abort cannot promise an individual HTTP refusal. */
export const statementDailyBudgetRefusal = (
  phase: "preflight" | "trigger"
): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: statementDailyBudgetMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () =>
    Effect.succeed(
      phase === "preflight" ? statementDailyBudgetResponse() : transactionUnavailable()
    ),
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
  refusal: StatementPublicationRefusal;
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
    if (disposition === "rate_limited") return Effect.succeed(statementDailyBudgetResponse());
    return Effect.succeed(transactionUnavailable());
  },
});

const guardedStatementRefusal =
  (config: StatementStagingConfig, publication: PreparedStatementPublication) =>
  ({ subject, current }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const generic = canonicalStatementRefusal({
      config,
      subject,
      current,
      refusal: {
        code: "validation_failed",
        auditOutcome: "validation_failed",
        message: "The statement submission could not complete.",
      },
    });
    return statementAbortRefusal(config, publication).pipe(
      Effect.map(
        Option.match({
          onNone: () => generic,
          onSome: (refusal) => canonicalStatementRefusal({ config, subject, current, refusal }),
        })
      )
    );
  };

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
        return refusedPreparation(statementDailyBudgetRefusal("preflight"));
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
          guardRefusal: guardedStatementRefusal(config, publication),
          auditBudget: "shared",
          commitGuards: Option.none(),
          outcome: {
            _tag: "StatementSubmission",
            operation: "ingestion.submitForExtraction",
            publication,
            config,
          },
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
