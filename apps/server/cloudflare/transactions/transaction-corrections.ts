import {
  Transaction,
  TransactionId,
  UpdateTransactionInput,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { transactionCaptureCompletion } from "@fidy/server/transaction-capture";
import { liveWebSessionAuthority } from "@fidy/server/identity-runtime";
import {
  livePATAuthority,
  recordCanonicalPATWork,
  recordLivePATUse,
} from "@fidy/server/tokens-runtime";
import { Data, DateTime, Effect, Option, Schema } from "effect";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import { prepareOwnedStatement } from "../pats/pat-unit";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { decodeTransactionRow } from "./transaction-history";
import { rejectManualTransaction } from "./transactions";
import {
  type TransactionSubject,
  refusedPATWork,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "./transaction-boundary";

const Input = Schema.toCodecJson(UpdateTransactionInput);
const Output = Schema.toCodecJson(Transaction);
const Decisions = Schema.Record(Schema.String, Schema.Boolean);
const Fields = Schema.Array(Schema.String);
const RevisionRow = Schema.Struct({ revision: Schema.Int });
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 2000,
});
type Subject = TransactionSubject | AuthorizedPAT;
type Correction = Readonly<{
  db: D1Database;
  subject: Subject;
  id: string;
  input: typeof Input.Type;
}>;
type Authority = ReturnType<typeof liveWebSessionAuthority> | ReturnType<typeof livePATAuthority>;
type Change = Readonly<{
  correction: Correction;
  authority: Authority;
  current: number;
  fields: ReadonlyArray<string>;
  previous: Transaction;
  updated: Transaction;
}>;
const isPAT = (subject: Subject): subject is AuthorizedPAT => "patId" in subject;
class CorrectionFailure extends Data.TaggedError("CorrectionFailure")<{}> {}
const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, CorrectionFailure> =>
  Effect.tryPromise({ try: run, catch: () => new CorrectionFailure() });
const rejectCorrection = (
  correction: Correction,
  outcome: "not_found" | "validation_failed"
): Effect.Effect<Response, CorrectionFailure> =>
  waitFor(() =>
    rejectManualTransaction({
      db: correction.db,
      subject: correction.subject,
      operation: "transactions.updateTransaction",
      outcome,
    })
  );

/** Decode a bounded correction without treating omitted facts as explicit decisions. */
export const correctionInput = (request: Request): Promise<Option.Option<typeof Input.Type>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(readBoundedRequestBody(request, policy))
    .then((bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Schema.decodeUnknownOption(Input)(parsed);
    })
    .catch(() => Option.none());
};

const retain = <A>(value: Option.Option<A>, previous: A): A =>
  Option.getOrElse(value, () => previous);
const invalidCorrection = (input: typeof Input.Type, current: number): boolean =>
  Object.keys(input.changes).length === 0 ||
  (input.changes.occurredAt !== undefined &&
    DateTime.toEpochMillis(input.changes.occurredAt) > current);
const replaceFacts = (
  previous: Transaction,
  changes: typeof Input.Type.changes
): Option.Option<Transaction> =>
  Schema.decodeOption(Transaction)({
    id: previous.id,
    direction: retain(Option.fromUndefinedOr(changes.direction), previous.direction),
    categoryId: retain(Option.fromUndefinedOr(changes.categoryId), previous.categoryId),
    money: {
      amount: encodeMoneyAmount(
        retain(Option.fromUndefinedOr(changes.money?.amount), previous.money.amount)
      ),
      currency: retain(Option.fromUndefinedOr(changes.money?.currency), previous.money.currency),
    },
    occurredAt: DateTime.formatIso(
      retain(Option.fromUndefinedOr(changes.occurredAt), previous.occurredAt)
    ),
    createdAt: DateTime.formatIso(previous.createdAt),
    ...Option.match(
      Option.getOrElse(
        Option.map(Option.fromUndefinedOr(changes.counterparty), Option.fromNullishOr),
        () => previous.counterparty
      ),
      { onNone: () => ({}), onSome: (counterparty) => ({ counterparty }) }
    ),
    ...Option.match(
      Option.getOrElse(
        Option.map(Option.fromUndefinedOr(changes.notes), Option.fromNullishOr),
        () => previous.notes
      ),
      { onNone: () => ({}), onSome: (notes) => ({ notes }) }
    ),
    revision: previous.revision + 1,
  });

const readOwned = (
  { db, subject, id }: Correction,
  authority: Authority
): Effect.Effect<"unauthorized" | Option.Option<Transaction>, CorrectionFailure> =>
  Effect.gen(function* () {
    const live = yield* waitFor(() =>
      db
        .prepare(`SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}`)
        .bind(...authority.bindings)
        .first()
    );
    if (live === null) return "unauthorized" as const;
    const row = yield* waitFor(() =>
      db
        .prepare(`SELECT id, amount, currency, direction, counterparty,
    category_id, notes, occurred_at, created_at, revision FROM transactions WHERE user_id = ? AND id = ?`)
        .bind(subject.userId, id)
        .first()
    );
    return decodeTransactionRow(row);
  });

type Evidence = Readonly<{
  before: string;
  after: string;
  decisions: string;
  fields: string;
  id: string;
}>;
const changeStatements = (
  { correction, authority, current, updated, previous }: Change,
  evidence: Evidence
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, id, input } = correction;
  return [
    db
      .prepare(`INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision,
      changed_fields, before_facts, after_facts, corrected_at)
      SELECT ?, user_id, id, ?, ?, ?, ?, ? FROM transactions
      WHERE user_id = ? AND id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        evidence.id,
        previous.revision,
        evidence.fields,
        evidence.before,
        evidence.after,
        DateTime.formatIso(DateTime.makeUnsafe(current)),
        subject.userId,
        id,
        input.expectedRevision,
        ...authority.bindings
      ),
    db
      .prepare(`UPDATE transactions SET amount = ?, currency = ?, direction = ?, category_id = ?,
      counterparty = ?, notes = ?, occurred_at = ?, revision = revision + 1,
      user_decisions = json_patch(user_decisions, ?) WHERE user_id = ? AND id = ? AND revision = ?
      AND changes() = 1 AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        encodeMoneyAmount(updated.money.amount),
        updated.money.currency,
        updated.direction,
        updated.categoryId,
        Option.getOrNull(updated.counterparty),
        Option.getOrNull(updated.notes),
        DateTime.formatIso(updated.occurredAt),
        evidence.decisions,
        subject.userId,
        id,
        input.expectedRevision,
        ...authority.bindings
      ),
  ];
};

const auditStatements = (
  { db, subject }: Correction,
  current: number,
  correctionId: string
): ReadonlyArray<D1PreparedStatement> =>
  isPAT(subject)
    ? [
        prepareOwnedStatement({
          db,
          statement: recordCanonicalPATWork({
            subject,
            input: {
              id: transactionId(),
              current,
              operation: "transactions.updateTransaction",
              outcome: "accepted",
              afterSourceAttestation: true,
            },
          }),
        }),
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
      ]
    : [
        db
          .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, ?, 'transactions.updateTransaction', 'success', ? FROM transaction_corrections
        WHERE id = ? AND user_id = ? AND changes() = 1`)
          .bind(transactionId(), subject.id, current, correctionId, subject.userId),
      ];

const staleAfterFailure = ({
  db,
  subject,
  id,
  input,
}: Correction): Effect.Effect<boolean, CorrectionFailure> =>
  waitFor(() =>
    db
      .prepare("SELECT revision FROM transactions WHERE user_id = ? AND id = ?")
      .bind(subject.userId, id)
      .first()
  ).pipe(
    Effect.map((row) => {
      const revision = Schema.decodeUnknownOption(RevisionRow)(row);
      return Option.isSome(revision) && revision.value.revision !== input.expectedRevision;
    })
  );

const commitCorrection = (
  change: Change
): Effect.Effect<Response, CorrectionFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { correction, fields, updated, previous } = change;
    const evidenceBefore = yield* Schema.encodeEffect(Schema.fromJsonString(Output))(previous);
    const evidenceAfter = yield* Schema.encodeEffect(Schema.fromJsonString(Output))(updated);
    const decisionPatch = yield* Schema.encodeEffect(Schema.fromJsonString(Decisions))(
      Object.fromEntries(fields.map((field) => [field, true]))
    );
    const changedFields = yield* Schema.encodeEffect(Schema.fromJsonString(Fields))(fields);
    const correctionId = transactionId();
    const statements = [
      ...changeStatements(change, {
        before: evidenceBefore,
        after: evidenceAfter,
        decisions: decisionPatch,
        fields: changedFields,
        id: correctionId,
      }),
      ...auditStatements(correction, change.current, correctionId),
      correction.db.prepare(transactionCaptureCompletion),
    ];
    const result = yield* waitFor(() => correction.db.batch(statements)).pipe(Effect.option);
    if (Option.isNone(result)) {
      return (yield* staleAfterFailure(correction))
        ? yield* rejectCorrection(correction, "validation_failed")
        : transactionUnavailable();
    }
    if (result.value.some((item) => item.meta.changes !== 1)) return transactionUnavailable();
    return Response.json(
      { data: yield* Schema.encodeEffect(Output)(updated), next: [] },
      { headers: transactionNoStore }
    );
  });

const refusedCorrection = ({
  db,
  subject,
}: Correction): Effect.Effect<Response, CorrectionFailure> =>
  isPAT(subject)
    ? waitFor(() => refusedPATWork({ db, userId: subject.userId }))
    : Effect.succeed(
        transactionFailure({
          code: "unauthenticated",
          status: 401,
          message: "Present a valid credential and retry.",
        })
      );

/** Correct selected owned facts under live caller authority, retaining immutable before/after evidence atomically. */
export const correctTransaction = (correction: Correction): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { subject, id, input } = correction;
      if (Option.isNone(Schema.decodeOption(TransactionId)(id))) {
        return yield* rejectCorrection(correction, "not_found");
      }
      const fields = Object.keys(input.changes);
      const current = transactionNow();
      if (invalidCorrection(input, current)) {
        return yield* rejectCorrection(correction, "validation_failed");
      }
      const authority = isPAT(subject)
        ? livePATAuthority({ subject, current })
        : liveWebSessionAuthority({ subject, current });
      const owned = yield* readOwned(correction, authority);
      if (owned === "unauthorized") {
        return yield* refusedCorrection(correction);
      }
      if (Option.isNone(owned)) {
        return yield* rejectCorrection(correction, "not_found");
      }
      if (owned.value.revision !== input.expectedRevision) {
        return yield* rejectCorrection(correction, "validation_failed");
      }
      const updated = replaceFacts(owned.value, input.changes);
      if (Option.isNone(updated)) {
        return yield* rejectCorrection(correction, "validation_failed");
      }
      return yield* commitCorrection({
        correction,
        authority,
        current,
        fields,
        previous: owned.value,
        updated: updated.value,
      });
    }).pipe(Effect.orElseSucceed(transactionUnavailable))
  );
