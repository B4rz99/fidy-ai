import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";

/** Removes channel evidence for tests that exercise the unassociated state. */
export const removeWhatsAppIdentityForTesting = (
  userId: UserId
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  withUserTransaction(
    userId,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`DELETE FROM whatsapp_identities WHERE user_id = ${userId}`
    ).pipe(Effect.asVoid, Effect.orDie)
  );
