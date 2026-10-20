import type { ConsentDeliveryInput } from "./contract";

import { Effect, Exit, Option } from "effect";

import {
  HTTP_CONFLICT,
  HTTP_OK,
  answer,
  attempt,
  findDelivery,
  maxKapsoFutureSkewMs,
  sameDelivery,
} from "./internal/ingress";

/** Record authenticated disclosure delivery without changing historical replay or decision timing. */
export const recordConsentDelivery = ({
  db,
  input,
}: Readonly<{ db: D1Database; input: ConsentDeliveryInput }>): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const existing = yield* findDelivery({ db, token: input.correlationToken });
    if (Option.isSome(existing)) {
      return answer(sameDelivery({ row: existing.value, input }) ? HTTP_OK : HTTP_CONFLICT);
    }
    const inserted = yield* Effect.exit(
      attempt(() =>
        db
          .prepare(
            `UPDATE pending_consent_exchanges SET delivery_phone_number_id=?2,delivery_message_id=?3,
              delivery_occurred_at_ms=?4,delivery_received_at_ms=?5,delivery_not_before_ms=?6
              WHERE correlation_token=?1 AND delivery_message_id IS NULL`
          )
          .bind(
            input.correlationToken,
            input.phoneNumberId,
            input.messageId,
            input.occurredAtMs,
            input.receivedAtMs,
            input.receivedAtMs + maxKapsoFutureSkewMs
          )
          .run()
      )
    );
    if (Exit.isSuccess(inserted) && inserted.value.meta.changes === 1) return answer(HTTP_OK);
    const retry = yield* findDelivery({ db, token: input.correlationToken });
    return answer(
      Option.isSome(retry) && sameDelivery({ row: retry.value, input }) ? HTTP_OK : HTTP_CONFLICT
    );
  });
