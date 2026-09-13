import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Records queue acquisitions so redelivery remains observable after work settles. */
export const durableQueueAcquisitions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE fidy_durable.fidy_queue
    ADD COLUMN IF NOT EXISTS acquisition_count INTEGER NOT NULL DEFAULT 0
      CHECK (acquisition_count >= 0)`;
  yield* sql`UPDATE fidy_durable.fidy_queue
    SET acquisition_count = attempts + CASE WHEN acquired_by IS NULL THEN 0 ELSE 1 END
    WHERE acquisition_count = 0`;
  yield* sql`CREATE OR REPLACE FUNCTION fidy_durable.count_fidy_queue_acquisition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.acquired_by IS NOT NULL THEN
        NEW.acquisition_count := OLD.acquisition_count + 1;
      END IF;
      RETURN NEW;
    END;
    $$`;
  yield* sql`DROP TRIGGER IF EXISTS count_fidy_queue_acquisition
    ON fidy_durable.fidy_queue`;
  yield* sql`CREATE TRIGGER count_fidy_queue_acquisition
    BEFORE UPDATE OF acquired_by ON fidy_durable.fidy_queue
    FOR EACH ROW
    EXECUTE FUNCTION fidy_durable.count_fidy_queue_acquisition()`;
}).pipe(Effect.asVoid);
