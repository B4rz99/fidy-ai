import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  ConfirmationDigest,
  type ConfirmationDigest as ConfirmationDigestType,
} from "./tool-confirmation-model";

const ConfirmationConsumption = Schema.Struct({
  userId: UserId,
  digest: ConfirmationDigest,
  consumedAt: Schema.DateTimeUtc,
});

/** Atomically consumes one User-owned confirmation digest; an existing claim returns false. */
export const consumeConfirmation = Effect.fn("consumeAgentConfirmation")(function* (
  userId: UserId,
  digest: ConfirmationDigestType,
  consumedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* withUserTransaction(
    userId,
    SqlSchema.findAll({
      Request: ConfirmationConsumption,
      Result: Schema.Struct({ consumed: Schema.Boolean }),
      execute: (request) => sql`
        INSERT INTO agent_confirmation_consumptions (user_id, digest, consumed_at)
        VALUES (${request.userId}, ${request.digest}, ${request.consumedAt})
        ON CONFLICT (user_id, digest) DO NOTHING
        RETURNING true AS consumed
      `,
    })({ userId, digest, consumedAt }).pipe(Effect.orDie)
  );
  return rows.length === 1;
});
