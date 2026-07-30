import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { categoryIds, categoryRows } from "~/core/categories/taxonomy";

/** Adds Categories, User rules, and immutable Transaction provenance. */
export const createCategorizedTransactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE categories (
      id uuid PRIMARY KEY,
      label text NOT NULL,
      display_order integer NOT NULL UNIQUE CHECK (display_order >= 0)
    )
  `;

  for (const category of categoryRows) {
    yield* sql`
      INSERT INTO categories (id, label, display_order)
      VALUES (${category.id}, ${category.label}, ${category.displayOrder})
    `;
  }

  yield* sql`
    CREATE TABLE keyword_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keyword text NOT NULL,
      normalized_keyword text NOT NULL,
      category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, normalized_keyword)
    )
  `;
  yield* sql`
    CREATE INDEX keyword_rules_user_id_idx ON keyword_rules (user_id, created_at, id)
  `;

  yield* sql`
    ALTER TABLE transactions
      ADD COLUMN category_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
      ADD COLUMN notes text,
      ADD COLUMN deleted_at timestamptz
  `;
  yield* sql`
    UPDATE transactions SET category_id = ${categoryIds.otros}
    WHERE category_id IS NULL
  `;
  yield* sql`ALTER TABLE transactions ALTER COLUMN category_id SET NOT NULL`;
  yield* sql`
    CREATE INDEX transactions_user_filters_idx
      ON transactions (user_id, category_id, direction, currency, occurred_at DESC)
      WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE TABLE source_attestations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind = 'manual'),
      service_market text NOT NULL CHECK (service_market = 'CO'),
      locale text NOT NULL CHECK (locale = 'es-CO'),
      time_zone text NOT NULL,
      source_channel text,
      source_provider text,
      interpretation_revision text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  yield* sql`
    CREATE INDEX source_attestations_transaction_id_created_at_idx
      ON source_attestations (transaction_id, created_at, id)
  `;

  yield* sql`
    CREATE FUNCTION reject_source_attestation_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'SourceAttestations are immutable';
    END;
    $$ LANGUAGE plpgsql
  `;
  yield* sql`
    CREATE TRIGGER source_attestations_are_immutable
      BEFORE UPDATE OR DELETE ON source_attestations
      FOR EACH ROW EXECUTE FUNCTION reject_source_attestation_mutation()
  `;
}).pipe(Effect.asVoid);
