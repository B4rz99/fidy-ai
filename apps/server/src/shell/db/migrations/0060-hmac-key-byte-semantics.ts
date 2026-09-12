import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { EmailAddress } from "~/core/email-authentication/model";
import { UserId } from "~/core/identity/reference";
import { emailCredentialLookupKey } from "~/shell/email-authentication/admission";

/**
 * Transitions every persisted value derived from the configured HMAC keys after those keys gained
 * their contracted exact 32-byte semantics. Credential lookup rows are re-derived from the
 * immutable verified email address. Admission budgets, anonymous source identifiers, pairing scope
 * evidence, and pending pairing start requests are discarded because their one-way keys cannot be
 * re-derived and every row is short-lived by contract.
 */
export const hmacKeyByteSemantics = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM email_pairing_login_admission_attempts;
    DELETE FROM email_pairing_login_admission_scopes;
    DELETE FROM email_delivery_admission_budgets;
    DELETE FROM browser_pairing_email_start_requests;
    DELETE FROM browser_login_start_attempts;
    DELETE FROM pat_pairing_start_attempts;
    DELETE FROM pat_pairing_claim_attempts
  `;
  const credentials = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ userId: UserId, emailAddress: EmailAddress }),
    execute: () => sql`
      SELECT user_id::text AS "userId", email_address AS "emailAddress"
      FROM verified_email_credentials
    `,
  })(undefined);
  yield* Effect.forEach(credentials, ({ userId, emailAddress }) =>
    Effect.gen(function* () {
      const lookupKey = yield* emailCredentialLookupKey(emailAddress);
      yield* sql`
        INSERT INTO verified_email_credential_authentication_lookups (
          user_id, authentication_lookup_key
        ) VALUES (${userId}, ${lookupKey})
        ON CONFLICT (user_id) DO UPDATE
          SET authentication_lookup_key = EXCLUDED.authentication_lookup_key
      `;
    })
  );
}).pipe(Effect.asVoid);
