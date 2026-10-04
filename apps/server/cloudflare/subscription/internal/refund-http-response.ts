import { Effect, Schema } from "effect";
import { RefundAttempt, type RefundStartFailure } from "../../../src/core/subscription/contract";

const statuses: Readonly<Record<RefundStartFailure, number>> = {
  unsupported: 403,
  "charge-unavailable": 404,
  "amount-exceeds-remaining": 409,
  "currency-mismatch": 400,
  "idempotency-conflict": 409,
  limited: 429,
  unavailable: 503,
};
const headers = { "cache-control": "no-store" };
export const refundFailureResponse = (failure: RefundStartFailure): Response =>
  Response.json({ error: { code: failure } }, { status: statuses[failure], headers });
export const refundResultResponse = (
  input: Readonly<{
    result: Effect.Effect<RefundAttempt, RefundStartFailure>;
    status: number;
  }>
): Effect.Effect<Response> =>
  input.result.pipe(
    Effect.flatMap(Schema.encodeEffect(Schema.toCodecJson(RefundAttempt))),
    Effect.map((data) => Response.json({ data }, { status: input.status, headers })),
    Effect.catch((error) =>
      Effect.succeed(refundFailureResponse(typeof error === "string" ? error : "unavailable"))
    )
  );
