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
          .prepare(`INSERT INTO pending_consent_delivery
      (correlation_token, phone_number_id, message_id, occurred_at_ms, received_at_ms, decision_not_before_ms)
      VALUES (?, ?, ?, ?, ?, ?)`)
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
    if (Exit.isSuccess(inserted)) return answer(HTTP_OK);
    const retry = yield* findDelivery({ db, token: input.correlationToken });
    return answer(
      Option.isSome(retry) && sameDelivery({ row: retry.value, input }) ? HTTP_OK : HTTP_CONFLICT
    );
  });
