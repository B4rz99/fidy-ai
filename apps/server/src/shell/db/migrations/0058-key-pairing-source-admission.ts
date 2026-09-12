import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/**
 * Retires the pre-keyed anonymous pairing admission logs. Their `source_digest` values were unkeyed
 * digests of the observed address, so no retained row can ever match a purpose-scoped HMAC
 * identifier. Deleting the rows is the explicit, bounded reset: it removes the enumerable address
 * evidence instead of translating it, and each new identifier starts its own rolling window rather
 * than inheriting or being exempted by a foreign one. Column comments record the admission-only
 * semantics for future readers of the schema.
 */
export const keyPairingSourceAdmission = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM browser_login_start_attempts;
    DELETE FROM pat_pairing_start_attempts;
    DELETE FROM pat_pairing_claim_attempts;

    COMMENT ON COLUMN browser_login_start_attempts.source_digest IS
      'Purpose-scoped keyed source identifier for abuse admission only; never identity or authorization evidence';
    COMMENT ON COLUMN pat_pairing_start_attempts.source_digest IS
      'Purpose-scoped keyed source identifier for abuse admission only; never identity or authorization evidence';
    COMMENT ON COLUMN pat_pairing_claim_attempts.source_digest IS
      'Purpose-scoped keyed source identifier for abuse admission only; never identity or authorization evidence'
  `;
}).pipe(Effect.asVoid);
