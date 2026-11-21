import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";

export const sampleAuthority = Effect.fn(function* (userId: string) {
  const sql = yield* SqliteClient;

  const statement = protectConsentStatement({
    subject: ConsentSubject.User({ userId: UserId.make(userId) }),
    requirement: "granted",
    statement: {
      sql: "SELECT id FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
      params: [userId, userId],
    },
  });

  return (yield* sql.unsafe(statement.sql, statement.params)).length === 1;
});
