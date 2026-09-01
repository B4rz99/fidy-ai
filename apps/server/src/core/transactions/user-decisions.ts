import { Effect, Option, Schema } from "effect";
import type { CreateTransactionInput } from "./model";

/**
 * Whether the User explicitly decided each current Transaction field state. A true Counterparty or
 * notes decision includes explicitly clearing that field; false means its state was automatic.
 */
export const TransactionUserDecisions = Schema.Struct({
  category: Schema.Boolean,
  counterparty: Schema.Boolean,
  notes: Schema.Boolean,
});
export type TransactionUserDecisions = typeof TransactionUserDecisions.Type;

/** No User decision is inferred from statement or notification-email extraction. */
export const automaticUserDecisions = TransactionUserDecisions.make({
  category: false,
  counterparty: false,
  notes: false,
});

/** A complete Transaction correction explicitly decides every represented field state. */
export const correctedUserDecisions = TransactionUserDecisions.make({
  category: true,
  counterparty: true,
  notes: true,
});

type CaptureUserDecisionInput = Readonly<{
  categoryId: CreateTransactionInput["categoryId"];
  counterparty: CreateTransactionInput["counterparty"];
  notes: CreateTransactionInput["notes"];
}>;

/** Decides which optional caller-capture facts were explicitly supplied by the User. */
export const decideCaptureUserDecisions = (
  input: CaptureUserDecisionInput
): Effect.Effect<TransactionUserDecisions> =>
  Effect.succeed(
    TransactionUserDecisions.make({
      category: Option.isSome(input.categoryId),
      counterparty: Option.isSome(input.counterparty),
      notes: Option.isSome(input.notes),
    })
  );
