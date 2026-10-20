import { prepareChangedRowAssertion } from "../../src/shell/sql-assertions/operations";
import { Effect, Option, Schema } from "effect";

import {
  RecurringWorkspace,
  RecurringWorkspaceQuery,
} from "../../src/shell/recurring-plans/contract";
import { RecurringCommand } from "../../src/core/recurring-plans/contract";
import { applyRecurringEdit, planAt } from "../../src/core/recurring-plans/operations";
import {
  type QueryCaller,
  boundaryFailure,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isOAuthCaller,
  liveTransactionAuthority,
  refusedPreparation,
  transactionFailure,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
} from "../canonical-operations/contract";
import { oauthMutationReview } from "../oauth-confirmation/operations";
import { type RecurringAuditWork, type RecurringEditWork } from "./contract";
import { snapshotCompletions } from "./internal/snapshot";
import { workspaceValue } from "./internal/query";
import { outcome, validReversal, validateReferences } from "./internal/mutation";
import { audit, credentialUse } from "./internal/audit";
import { encodeDocument, readDocument, writeDocument } from "./internal/store";

const operation = "recurringPlans.applyRecurringEdit";

/** Observational canonical read. Only credential use and metadata Audit are written. */
export const browseRecurringPlans = ({
  db,
  subject,
  request,
}: Readonly<{ db: D1Database; subject: QueryCaller; request: Request }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    if (!(yield* Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })))) {
      return transactionFailure({
        code: "unauthenticated",
        status: 401,
        message: "Presenta una credencial vigente.",
      });
    }
    const query = Schema.decodeUnknownOption(RecurringWorkspaceQuery)(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (Option.isNone(query)) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Selecciona un mes válido.",
      });
    }
    if (query.value.previousMonth !== undefined && query.value.previousMonth >= query.value.month) {
      return transactionFailure({
        code: "validation_failed",
        status: 400,
        message: "Selecciona un mes anterior.",
      });
    }
    const document = yield* readDocument({ db, userId: subject.userId });
    const view = yield* workspaceValue({
      db,
      userId: subject.userId,
      document,
      query: query.value,
    });
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(RecurringWorkspace))(view);
    yield* Effect.tryPromise({
      try: () =>
        db.batch([
          ...credentialUse({ db, subject, current }),
          audit({
            work: { db, subject, current },
            operation: "recurringPlans.getRecurringWorkspace",
            outcome: "accepted",
          }),
          prepareChangedRowAssertion({ db, scope: "recurring_plan" }),
        ]),
      catch: boundaryFailure,
    });
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(() => transactionUnavailable()));

/** Prepare, never commit, a revision-bound User mutation inside the existing canonical unit. */
export const prepareRecurringEdit = ({
  work,
  command,
}: RecurringEditWork): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (!(yield* Effect.tryPromise(() => liveTransactionAuthority(work)))) {
      return credentialRefusedPreparation();
    }
    const base = yield* readDocument({ db: work.db, userId: work.subject.userId });
    if (!(yield* validReversal({ work, command, document: base }))) {
      return refusedPreparation(recurringRefusal(work));
    }
    const stable = yield* snapshotCompletions({ work, document: base, command });
    const decision = yield* applyRecurringEdit({ document: stable, command }).pipe(Effect.option);
    if (Option.isNone(decision)) return refusedPreparation(recurringRefusal(work));
    if (!(yield* validateReferences({ work, command, document: decision.value }))) {
      return refusedPreparation(recurringRefusal(work));
    }
    const encoded = yield* encodeDocument(decision.value);
    const edit = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(RecurringCommand))
    )(command);
    const oauthReview = isOAuthCaller(work.subject)
      ? Option.some(
          oauthMutationReview({
            db: work.db,
            effect: `Actualizar el seguimiento recurrente según esta decisión explícita: ${edit}. No mueve dinero ni cancela servicios.`,
            revision: `${base.revision}`,
            guard:
              base.revision === 0
                ? {
                    sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM user_documents WHERE kind='recurring-plan' AND user_id = ?)",
                    params: [work.subject.userId],
                  }
                : {
                    sql: "SELECT 1 FROM user_documents WHERE kind='recurring-plan' AND user_id = ? AND revision = ?",
                    params: [work.subject.userId, base.revision],
                  },
          })
        )
      : Option.none();
    return {
      _tag: "Prepared" as const,
      mutation: {
        oauthReview,
        requiredScope: callerScope(work.subject),

        commitGuards: Option.none(),
        statements: [
          ...credentialUse(work),
          writeDocument({ work, document: decision.value, encoded }),
          prepareChangedRowAssertion({ db: work.db, scope: "recurring_plan" }),
          audit({ work, operation, outcome: "accepted" }),
        ],
        outcome: outcome(),
        guardRefusal: (current) => Effect.succeed(recurringRefusal(current)),
      },
    };
  }).pipe(Effect.orElseSucceed(failedPreparation));

export const recurringRefusal = (work: RecurringAuditWork): CanonicalMutationRefusal => ({
  code: "validation_failed",
  message: "Revisa los datos y actualiza los recurrentes antes de guardar.",
  record: () =>
    Effect.tryPromise(() =>
      work.db.batch([
        ...credentialUse(work),
        audit({ work, operation: "recurringPlans.applyRecurringEdit", outcome: "rejected" }),
        prepareChangedRowAssertion({ db: work.db, scope: "recurring_plan" }),
      ])
    ).pipe(
      Effect.as("recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    Effect.succeed(
      disposition === "recorded"
        ? transactionFailure({
            code: "validation_failed",
            status: 400,
            message: "Revisa los datos y actualiza los recurrentes antes de guardar.",
          })
        : transactionUnavailable()
    ),
});

/** Describe an owned, revision-bound lifecycle decision without exposing storage identities. */
export const describeRecurringLifecycle = ({
  db,
  userId,
  command,
}: Readonly<{ db: D1Database; userId: string; command: RecurringCommand }>): Effect.Effect<
  Option.Option<string>
> =>
  Effect.gen(function* () {
    const edit = command.edit;
    if (edit.kind !== "lifecycle") return Option.none();
    const document = yield* readDocument({ db, userId });
    if (document.revision !== command.expectedRevision) return Option.none();
    const plan = document.plans.find((entry) => entry.id === edit.planId);
    if (plan === undefined) return Option.none();
    const actions = { pause: "Pausar", resume: "Reanudar", stop: "Dejar de seguir" };
    const date = edit.date.split("-").reverse().join("-");
    return Option.some(
      `${actions[edit.action]} «${planAt({ plan, date: edit.date }).name}» desde el ${date}. ` +
        "Conserva el historial y no cancela servicios ni mueve dinero."
    );
  }).pipe(Effect.orElseSucceed(() => Option.none()));
