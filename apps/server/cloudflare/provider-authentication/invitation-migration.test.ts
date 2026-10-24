import { afterAll, expect, it } from "vitest";
import { Effect } from "effect";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { schemaStatements } from "../schema-cutover.test-fixture";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "15310000-0000-4000-8000-000000000001";
const snapshot = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    db.prepare("SELECT * FROM users"),
    db.prepare("SELECT * FROM provider_credentials"),
    db.prepare("SELECT * FROM consent_history"),
    db.prepare("SELECT * FROM whatsapp_provider_handoffs"),
  ]);
it("expands a populated baseline atomically and preserves identity/history with valid foreign keys", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const baseline = schemaStatements(
        yield* Effect.tryPromise(() =>
          Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
        )
      );
      const expansion = schemaStatements(
        yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../migrations/0002_whatsapp_signup_invitations.sql", import.meta.url)
          ).text()
        )
      );
      yield* Effect.tryPromise(() => db.batch(baseline.map((sql) => db.prepare(sql))));
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
            )
            .bind(userId),
          db
            .prepare(
              "INSERT INTO provider_credentials(issuer,subject,user_id,contact_email,established_at_ms) VALUES('https://accounts.google.com','retained-subject',?,'person@example.test',1)"
            )
            .bind(userId),
        ])
      );
      const before = yield* Effect.tryPromise(() => snapshot(db));
      yield* Effect.tryPromise(() =>
        expect(
          db.batch([
            ...expansion.map((sql) => db.prepare(sql)),
            db.prepare(
              "INSERT INTO sql_assertions(scope,accepted) VALUES('invitation-migration',0)"
            ),
          ])
        ).rejects.toThrow("CHECK constraint failed")
      );
      expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
        before.map((table) => table.results)
      );
      yield* Effect.tryPromise(() => db.batch(expansion.map((sql) => db.prepare(sql))));
      expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
        before.map((table) => table.results)
      );
      expect(
        (yield* Effect.tryPromise(() => db.prepare("PRAGMA foreign_key_check").all())).results
      ).toEqual([]);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM whatsapp_signup_invitations").first()
        )
      ).toEqual({ total: 0 });
    })
  ));
