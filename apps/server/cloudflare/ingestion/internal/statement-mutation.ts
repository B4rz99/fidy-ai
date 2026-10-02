import { getCanonicalOperationInput } from "@fidy/server/canonical-runtime";
import { StatementSubmission } from "@fidy/server/ingestion-contract";
import { Effect, Exit, Option, Schema } from "effect";
import { dailyAuditExhausted } from "@fidy/server/audit";
import {
  type PreparedStatementPublication,
  type StatementPublicationRefusal,
  type StatementStagingConfig,
  lostStatementReplay,
  prepareStagedStatementPublication,
  readOwnedStatementSubmission,
  recordStatementRefusal,
  statementAbortRefusal,
  statementRefusal,
  submissionProjection,
} from "./statement-staging";
import {
  statementDailyBudgetMessage,
  statementDailyBudgetResponse,
  statementRefusalResponse,
} from "./statement-ingestion";
import {
  callerAuthority,
  callerScope,
  transactionNoStore,
  transactionUnavailable,
} from "../../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type GuardRefusalWork,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "../../mutations/mutation-types";
import type { CanonicalMutationAdapter } from "../../mutations/canonical-mutation-registry";

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

/** Read only public lifecycle after the unit commits; transient adapter failures get bounded retries. */
const committedSubmission =
  (config: StatementStagingConfig, publication: PreparedStatementPublication) =>
  (userId: string): Effect.Effect<Option.Option<StatementSubmission>> =>
    Effect.gen(function* () {
      const read = readOwnedStatementSubmission(config, {
        userId,
        submissionId: publication.submissionId,
      });
      let result = yield* Effect.exit(read);
      for (let attempt = 1; attempt < 3 && Exit.isFailure(result); attempt += 1) {
        result = yield* Effect.exit(read);
      }
      return Exit.isFailure(result)
        ? Option.none()
        : Option.flatMap(result.value, submissionProjection);
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
            publication: {
              readCommitted: committedSubmission(config, publication),
              lostReplay: lostStatementReplay(config, publication),
            },
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
