import { TransactionPairInput } from "../../../src/core/transactions/contract";
import { type Effect, type Option, Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { maximumTransactionInputBytes } from "../../canonical-work/operations";

const Input = Schema.toCodecJson(TransactionPairInput);

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});

export const transactionPairInput = (
  request: Request
): Effect.Effect<Option.Option<typeof Input.Type>> =>
  boundedJsonBody({ request, policy, schema: Input });
