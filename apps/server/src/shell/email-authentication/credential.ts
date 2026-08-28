import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EmailAddress } from "~/core/email-authentication/model";
import type { UserId } from "~/core/identity/reference";

const VerifiedEmailRow = Schema.Struct({ email: EmailAddress });

/** Reads the User's mandatory current verified mailbox inside the caller's User transaction. */
export const getVerifiedEmailInScope = Effect.fn("EmailAuthentication.getVerifiedEmailInScope")(
  function* (userId: UserId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: VerifiedEmailRow,
      execute: () => sql`
        SELECT email_address AS email
        FROM verified_email_credentials
        WHERE user_id = ${userId}
      `,
    })(undefined).pipe(Effect.orDie);
  }
);
