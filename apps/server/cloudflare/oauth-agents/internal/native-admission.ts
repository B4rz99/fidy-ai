import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect } from "effect";

const userWindowMilliseconds = 60_000;

const userLimit = 60;

export const admitUserOAuth = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM oauth_user_admissions WHERE expires_at_ms<=${current}`;

  const inserted =
    yield* sql`INSERT INTO oauth_user_admissions(expires_at_ms) SELECT ${current + userWindowMilliseconds} WHERE (SELECT count(*) FROM oauth_user_admissions)<${userLimit} RETURNING expires_at_ms`;

  return inserted.length === 1;
});
