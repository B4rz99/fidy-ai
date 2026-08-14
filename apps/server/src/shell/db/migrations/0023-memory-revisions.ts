import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the server-owned per-User stamp advanced atomically by every Memory row mutation. */
export const memoryRevisions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE memory_revisions (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )
  `;

  yield* sql`
    INSERT INTO memory_revisions (user_id, revision)
    SELECT user_id, count(*) FROM memories GROUP BY user_id
  `;

  yield* sql`
    ALTER TABLE memory_revisions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE memory_revisions FORCE ROW LEVEL SECURITY;
    CREATE POLICY memory_revisions_by_user ON memory_revisions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;

  yield* sql`
    CREATE FUNCTION fidy_advance_memory_revision() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      subject_user_id uuid;
    BEGIN
      subject_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
      INSERT INTO public.memory_revisions (user_id, revision)
      VALUES (subject_user_id, 1)
      ON CONFLICT (user_id) DO UPDATE
      SET revision = public.memory_revisions.revision + 1;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $function$
  `;
  yield* sql`
    REVOKE ALL ON FUNCTION fidy_advance_memory_revision() FROM PUBLIC
  `;
  yield* sql`
    CREATE TRIGGER advance_memory_revision
    AFTER INSERT OR UPDATE OR DELETE ON memories
    FOR EACH ROW EXECUTE FUNCTION fidy_advance_memory_revision()
  `;

  yield* sql`
    GRANT SELECT ON memory_revisions TO fidy_runtime;
    GRANT UPDATE, DELETE ON memories TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
