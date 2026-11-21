import { BudgetThresholdEvaluation } from "../../budgets/contract";
import { localCorrectionReview } from "./oauth-review";
import { CategoryReference } from "../../../src/core/categories/contract";
import { commitLocalWrite, prepareLocalWrite } from "../../canonical-admission/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import type { UserId } from "../../../src/core/identity/contract";
import {
  RestoredTransactionPair,
  type TransactionPairInput,
  TransactionPresentation,
  type UpdateTransactionInput,
} from "../../../src/core/transactions/contract";
import {
  decideTransactionLink,
  orderTransactionPair,
} from "../../../src/core/transactions/operations";
import { TransactionInspection } from "../../../src/shell/transactions/contract";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
} from "../../canonical-admission/contract";
import {
  alreadyLinkedMessage,
  missingTransactionMessage,
  pairPolicyMessage,
  unlinkedPairMessage,
} from "../../canonical-work/operations";
import { resolveLocalCategory, retainLocalCategory } from "../../categories/operations";
import {
  TransactionOutput,
  decodeInspectionRow,
  decodeTransactionRow,
  presentationQuery,
} from "./transaction-history";
import { correctionEvidence, invalidCorrection, replaceFacts } from "./transaction-corrections";
import { staleCorrectionMessage } from "./transaction-outcome";
import { localTransactionRefusal } from "./sqlite-capture";

export const missingLocalTransaction = (): LocalMutationResult =>
  localTransactionRefusal({ status: 404, code: "not_found", message: missingTransactionMessage });

const invalid = (message: string): LocalMutationResult =>
  localTransactionRefusal({ status: 400, code: "validation_failed", message });

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const unavailable = (cause: string): CanonicalAdmissionUnavailable =>
  new CanonicalAdmissionUnavailable({ cause });

const retained = Effect.fn(function* (user: UserId, id: string) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT *,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at FROM transactions
    WHERE user_id=${user} AND id=${id} AND deleted_at_ms IS NULL`;

  if (row === undefined) return Option.none();

  const record = yield* Effect.fromOption(decodeTransactionRow(row), () =>
    unavailable("retained_transaction")
  );

  const members = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      category_revision: Schema.String,
      reconciliation_first_id: Schema.NullOr(Schema.String),
      reconciliation_second_id: Schema.NullOr(Schema.String),
    })
  )(row);

  return Option.some({ record, ...members });
});

const refresh = Effect.fn(function* (
  user: UserId,
  { first, second }: Readonly<{ first: string; second: string }>,
  expected: number
) {
  const sql = yield* SqliteClient;

  const [state] = yield* sql`UPDATE transaction_projection_state SET
    fact_revision=fact_revision+1,
    repair_revision=repair_revision+CASE WHEN readiness='ready' THEN 0 ELSE 1 END,
    readiness=CASE WHEN readiness='ready' THEN readiness ELSE 'dirty' END
    WHERE user_id=${user} RETURNING readiness,version`;

  const ready = Schema.decodeUnknownOption(
    Schema.Struct({ readiness: Schema.Literal("ready"), version: Schema.Literal(1) })
  )(state);

  if (Option.isNone(ready)) return;
  yield* sql`DELETE FROM transaction_projection_leaf WHERE user_id=${user} AND id IN (${first},${second})`;

  const refreshed =
    yield* sql`INSERT INTO transaction_projection_leaf(user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision)
    SELECT user_id,id,amount,currency,direction,category_id,category_revision,counterparty,notes,occurred_at_ms,created_at_ms,revision
    FROM transaction_effective_source WHERE user_id=${user} AND id IN (${first},${second}) RETURNING id`;

  if (refreshed.length !== expected) return yield* unavailable("transaction_projection");
});

const correctionCategory = Effect.fn(function* ({
  user,
  input,
  previous,
  direction,
}: Readonly<{
  user: UserId;
  input: UpdateTransactionInput;
  previous: string;
  direction: typeof TransactionOutput.Type.direction;
}>) {
  if (input.changes.categoryId === undefined) return Option.some(previous);

  return yield* resolveLocalCategory({
    userId: user,
    capture: {
      caller: Option.some(input.changes.categoryId),
      direction,
      counterparty: Option.none(),
    },
  }).pipe(
    Effect.map(({ revision }) => Option.some(revision)),
    Effect.tapError(Effect.logDebug),
    Effect.catchTag("CategoryNotFound", () => Effect.succeedNone)
  );
});

const refreshCorrectedProjection = Effect.fn(function* (
  user: UserId,
  id: string,
  member: OwnedMember
) {
  yield* refresh(
    user,
    { first: member.reconciliation_first_id ?? id, second: member.reconciliation_second_id ?? id },
    1
  );
});

const correctionTargets = (id: string, member: OwnedMember): ReadonlyArray<string> =>
  Option.match(Option.fromNullOr(member.reconciliation_first_id), {
    onNone: () => [id],
    onSome: (first) => [id, first, member.reconciliation_second_id ?? id],
  }).map((member) => "transaction:" + member);

export const prepareLocalCorrection = Effect.fn(function* (
  { id, input }: { id: string; input: UpdateTransactionInput },
  user: UserId,
  current: number
) {
  if (invalidCorrection({ input, current })) {
    return invalid("The correction must change at least one fact and cannot occur in the future.");
  }

  const owned = yield* retained(user, id);

  if (Option.isNone(owned)) return missingLocalTransaction();
  const previous = owned.value.record;

  if (previous.revision !== input.expectedRevision) return invalid(staleCorrectionMessage);
  const result = replaceFacts({ previous, changes: input.changes });

  if (Option.isNone(result)) return invalid("The supplied Transaction facts are invalid.");
  const updated = result.value;
  const sql = yield* SqliteClient;

  const categoryRevision = yield* correctionCategory({
    user,
    input,
    previous: owned.value.category_revision,
    direction: updated.direction,
  });

  if (Option.isNone(categoryRevision)) {
    return localTransactionRefusal({
      status: 404,
      code: "not_found",
      message: "The Category does not exist; correct categoryId and retry.",
    });
  }

  const revision = categoryRevision.value;
  const evidence = yield* correctionEvidence({ previous, updated, changes: input.changes });

  return prepareLocalWrite({
    targets: correctionTargets(id, owned.value),
    review: localCorrectionReview(user, id, Option.some(evidence.after)),
    commit: Effect.gen(function* () {
      if (input.changes.categoryId !== undefined) {
        yield* retainLocalCategory({
          categoryId: updated.categoryId,
          revision: yield* Schema.decodeEffect(CategoryReference.fields.revision)(revision),
        });
      }

      const inserted =
        yield* sql`INSERT INTO transaction_corrections(id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms,before_category_revision,after_category_revision)
     VALUES(${evidence.id},${user},${id},${previous.revision},${evidence.fields},${evidence.before},${evidence.after},${current},${owned.value.category_revision},${revision}) RETURNING id`;

      const changed =
        yield* sql`UPDATE transactions SET amount=${encodeMoneyAmount(updated.money.amount)},currency=${updated.money.currency},
    direction=${updated.direction},category_id=${updated.categoryId},category_revision=${revision},
    counterparty=${Option.getOrNull(updated.counterparty)},notes=${Option.getOrNull(updated.notes)},occurred_at_ms=${DateTime.toEpochMillis(updated.occurredAt)},
    revision=revision+1,user_decisions=json_patch(user_decisions,${evidence.decisions}) WHERE id=${id} AND user_id=${user} AND revision=${previous.revision} RETURNING id`;

      if (inserted.length !== 1 || changed.length !== 1) {
        return yield* unavailable("correction_commit");
      }

      yield* refreshCorrectedProjection(user, id, owned.value);
      yield* (yield* BudgetThresholdEvaluation)(user, current);

      return success(yield* Schema.encodeEffect(TransactionOutput)(updated));
    }),
  });
});

export const correctLocalTransaction = Effect.fnUntraced(function* (
  input: { id: string; input: UpdateTransactionInput },
  user: UserId,
  current: number
) {
  return yield* prepareLocalCorrection(input, user, current).pipe(Effect.flatMap(commitLocalWrite));
});

export const inspectLocalTransaction = Effect.fn(function* (id: string, user: UserId) {
  const sql = yield* SqliteClient;
  const query = presentationQuery({ userId: user, id, authority: Option.none() });
  const [row] = yield* sql.unsafe(query.sql, query.bindings);

  if (row === undefined) return missingLocalTransaction();

  const detail = yield* Effect.fromOption(decodeInspectionRow(row), () =>
    unavailable("transaction_inspection")
  );

  return success(yield* Schema.encodeEffect(Schema.toCodecJson(TransactionInspection))(detail));
});

type OwnedMember = Option.Option.Value<Effect.Success<ReturnType<typeof retained>>>;

type PairWork = Readonly<{
  user: UserId;
  current: number;
  first: string;
  second: string;
  left: OwnedMember;
  right: OwnedMember;
}>;

const linkPair = Effect.fn(function* ({ user, current, first, second, left, right }: PairWork) {
  const sql = yield* SqliteClient;

  if (left.reconciliation_first_id !== null || right.reconciliation_first_id !== null) {
    return invalid(alreadyLinkedMessage);
  }

  const decision = yield* decideTransactionLink(left.record, right.record).pipe(Effect.option);

  if (Option.isNone(decision)) return invalid(pairPolicyMessage);
  const visible = decision.value.visibleTransactionId;

  return prepareLocalWrite({
    targets: ["transaction:" + first, "transaction:" + second],
    commit: Effect.gen(function* () {
      const written =
        yield* sql`INSERT INTO transaction_reconciliation_decisions VALUES (${user},${first},${second},'linked',${visible},${current})
      ON CONFLICT(user_id,first_transaction_id,second_transaction_id) DO UPDATE SET state='linked',visible_transaction_id=excluded.visible_transaction_id,decided_at_ms=excluded.decided_at_ms WHERE state='keep-separate' RETURNING state`;

      const members =
        yield* sql`UPDATE transactions SET reconciliation_first_id=${first},reconciliation_second_id=${second}
      WHERE user_id=${user} AND id IN (${first},${second}) AND reconciliation_first_id IS NULL RETURNING id`;

      if (written.length !== 1 || members.length !== 2) return yield* unavailable("link_commit");
      yield* refresh(user, { first, second }, 1);
      yield* (yield* BudgetThresholdEvaluation)(user, current);

      const [row] =
        yield* sql`SELECT * FROM transaction_effective_source WHERE user_id=${user} AND id=${visible}`;

      const effective = yield* Effect.fromOption(decodeTransactionRow(row), () =>
        unavailable("effective_transaction")
      );

      return success(
        yield* Schema.encodeEffect(Schema.toCodecJson(TransactionPresentation))({
          ...effective,
          presentation: { kind: "visible-member" },
        })
      );
    }),
  });
});

const unlinkPair = Effect.fn(function* ({ user, current, first, second, left, right }: PairWork) {
  const sql = yield* SqliteClient;

  if (
    left.reconciliation_first_id !== first ||
    left.reconciliation_second_id !== second ||
    right.reconciliation_first_id !== first ||
    right.reconciliation_second_id !== second
  ) {
    return invalid(unlinkedPairMessage);
  }

  return prepareLocalWrite({
    targets: ["transaction:" + first, "transaction:" + second],
    commit: Effect.gen(function* () {
      const members =
        yield* sql`UPDATE transactions SET reconciliation_row_ref=NULL,reconciliation_first_id=NULL,reconciliation_second_id=NULL
    WHERE user_id=${user} AND reconciliation_first_id=${first} AND reconciliation_second_id=${second} RETURNING id`;

      const written =
        yield* sql`UPDATE transaction_reconciliation_decisions SET state='keep-separate',visible_transaction_id=NULL,decided_at_ms=${current}
    WHERE user_id=${user} AND first_transaction_id=${first} AND second_transaction_id=${second} AND state='linked' RETURNING state`;

      if (written.length !== 1 || members.length !== 2) return yield* unavailable("unlink_commit");
      yield* refresh(user, { first, second }, 2);
      yield* (yield* BudgetThresholdEvaluation)(user, current);

      return success(
        yield* Schema.encodeEffect(Schema.toCodecJson(RestoredTransactionPair))({
          firstTransaction: { ...left.record, presentation: { kind: "independent" } },
          secondTransaction: { ...right.record, presentation: { kind: "independent" } },
        })
      );
    }),
  });
});

export const prepareLocalPair = Effect.fn(function* (
  { link, input }: { link: boolean; input: TransactionPairInput },
  user: UserId,
  current: number
) {
  const ordered = yield* orderTransactionPair(input).pipe(Effect.option);

  if (Option.isNone(ordered)) {
    return invalid("A Transaction pair needs two different Transaction ids.");
  }

  const { firstTransactionId: first, secondTransactionId: second } = ordered.value;
  const left = yield* retained(user, first);
  const right = yield* retained(user, second);

  if (Option.isNone(left) || Option.isNone(right)) return missingLocalTransaction();
  const work = { user, current, first, second, left: left.value, right: right.value };

  return yield* link ? linkPair(work) : unlinkPair(work);
});

export const reconcileLocalTransactions = Effect.fnUntraced(function* (
  input: { link: boolean; input: TransactionPairInput },
  user: UserId,
  current: number
) {
  return yield* prepareLocalPair(input, user, current).pipe(Effect.flatMap(commitLocalWrite));
});

export const prepareLocalDeletion = Effect.fn(function* (
  id: string,
  user: UserId,
  current: number
) {
  const owned = yield* retained(user, id);

  if (Option.isNone(owned)) return missingLocalTransaction();

  if (owned.value.reconciliation_first_id !== null) {
    return invalid("Unlink the Transaction pair before deleting either original Transaction.");
  }

  const sql = yield* SqliteClient;

  return prepareLocalWrite({
    targets: ["transaction:" + id],
    review: localCorrectionReview(user, id, Option.none()),
    commit: Effect.gen(function* () {
      const changed =
        yield* sql`UPDATE transactions SET deleted_at_ms=${current} WHERE user_id=${user} AND id=${id} AND revision=${owned.value.record.revision} AND deleted_at_ms IS NULL AND reconciliation_first_id IS NULL RETURNING id`;

      if (changed.length !== 1) return yield* unavailable("transaction_delete");
      yield* refresh(user, { first: id, second: id }, 0);
      yield* (yield* BudgetThresholdEvaluation)(user, current);

      return success(id);
    }),
  });
});

export const deleteLocalTransaction = Effect.fnUntraced(function* (
  id: string,
  user: UserId,
  current: number
) {
  return yield* prepareLocalDeletion(id, user, current).pipe(Effect.flatMap(commitLocalWrite));
});
