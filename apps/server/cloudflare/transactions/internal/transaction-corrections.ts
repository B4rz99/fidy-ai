import { Transaction, UpdateTransactionInput } from "../../../src/core/transactions/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { DateTime, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { maximumTransactionInputBytes, transactionId } from "../../canonical-work/operations";
import { type StoredTransaction, TransactionOutput } from "./transaction-history";

const Input = Schema.toCodecJson(UpdateTransactionInput);

const Decisions = Schema.Record(Schema.String, Schema.Boolean);

const Fields = Schema.Array(Schema.String);

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});

export const correctionInput = (
  request: Request
): Effect.Effect<Option.Option<typeof Input.Type>> =>
  boundedJsonBody({ request, policy, schema: Input });

const retain = <A>(value: Option.Option<A>, previous: A): A =>
  Option.getOrElse(value, () => previous);

export const invalidCorrection = ({
  input,
  current,
}: Readonly<{ input: typeof Input.Type; current: number }>): boolean =>
  Object.keys(input.changes).length === 0 ||
  (input.changes.occurredAt !== undefined &&
    DateTime.toEpochMillis(input.changes.occurredAt) > current);

export const replaceFacts = ({
  previous,
  changes,
}: Readonly<{
  previous: StoredTransaction;
  changes: typeof Input.Type.changes;
}>): Option.Option<StoredTransaction> =>
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

type Evidence = Readonly<{
  before: string;
  after: string;
  decisions: string;
  fields: string;
  id: string;
}>;

export const correctionEvidence = ({
  previous,
  updated,
  changes,
}: Readonly<{
  previous: StoredTransaction;
  updated: StoredTransaction;
  changes: typeof Input.Type.changes;
}>): Effect.Effect<Evidence, Schema.SchemaError> =>
  Effect.gen(function* () {
    const fields = Object.keys(changes);

    return {
      before: yield* Schema.encodeEffect(Schema.fromJsonString(TransactionOutput))(previous),
      after: yield* Schema.encodeEffect(Schema.fromJsonString(TransactionOutput))(updated),
      decisions: yield* Schema.encodeEffect(Schema.fromJsonString(Decisions))(
        Object.fromEntries(fields.map((field) => [field, true]))
      ),
      fields: yield* Schema.encodeEffect(Schema.fromJsonString(Fields))(fields),
      id: transactionId(),
    };
  });
