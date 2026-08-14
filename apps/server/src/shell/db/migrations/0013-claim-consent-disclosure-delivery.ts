import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Serializes pre-subject disclosure sends without holding a transaction across provider work. */
export const claimConsentDisclosureDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE pending_consent_exchanges
      ADD COLUMN disclosure_delivery_claim_id uuid,
      ADD COLUMN disclosure_delivery_claim_expires_at timestamptz,
      ADD COLUMN disclosure_delivery_started_at timestamptz,
      ADD CONSTRAINT pending_consent_delivery_claim_pair CHECK (
        (disclosure_delivery_claim_id IS NULL) =
        (disclosure_delivery_claim_expires_at IS NULL)
      ),
      ADD CONSTRAINT pending_consent_delivery_started_requires_claim CHECK (
        disclosure_delivery_started_at IS NULL OR disclosure_delivery_claim_id IS NOT NULL
      )
  `;
});
