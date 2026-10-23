import { Effect, Schema } from "effect";
import type { Cause } from "effect";
import { expect } from "vitest";
import {
  documentedSqlBlock,
  installHistoricalErasureChunk,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const snapshot = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[
      "pending_consent_exchanges",
      "whatsapp_provider_handoffs",
      "provider_authentication_attempts",
      "users",
      "provider_credentials",
      "backup_recovery_credentials",
      "consent_history",
      "erasure_archives",
    ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"),
  ]);
type Cutover = Readonly<{ db: D1Database; reference: string; statements: ReadonlyArray<string> }>;
const prepareCutover = (db: D1Database): Effect.Effect<ReadonlyArray<string>, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() => installHistoricalErasureChunk(db));
    const baseline = schemaStatements(
      yield* Effect.tryPromise(() =>
        Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
      )
    );
    const prior = schemaStatements(
      yield* Effect.tryPromise(() =>
        Bun.file(new URL("./handoff-before-1445.fixture.sql", import.meta.url)).text()
      )
    );
    const guide = yield* Effect.tryPromise(() =>
      Bun.file(
        new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
      ).text()
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("DROP TRIGGER whatsapp_provider_handoff_immutable"),
        ...prior.map((sql) => db.prepare(sql)),
      ])
    );
    return [
      ...documentedSqlBlock({ guide, marker: "provider-handoff-preflight" }),
      "DROP TRIGGER whatsapp_provider_completion_consumes_confirmation",
      schemaDefinition({ source: baseline, target: "whatsapp_provider_handoff_immutable" }),
      "DELETE FROM sql_assertions WHERE scope='provider_handoff_cutover'",
    ];
  });
const refuseMissingDecision = ({
  db,
  reference,
  statements,
}: Cutover): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const original = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ decision_message_id: Schema.String })
    )(
      yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT decision_message_id FROM whatsapp_provider_handoffs WHERE id=?")
          .bind(reference)
          .first()
      )
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE whatsapp_provider_handoffs SET decision_message_id=NULL WHERE id=?")
        .bind(reference)
        .run()
    );
    const before = yield* Effect.tryPromise(() => snapshot(db));
    yield* Effect.tryPromise(() =>
      expect(db.batch(statements.map((sql) => db.prepare(sql)))).rejects.toThrow(
        "CHECK constraint failed"
      )
    );
    expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
      before.map((table) => table.results)
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE whatsapp_provider_handoffs SET decision_message_id=? WHERE id=?")
        .bind(original.decision_message_id, reference)
        .run()
    );
  });

/** Install the synchronized handoff cutover over confirmed proof from the public journey. */
export const verifyHandoffCutover = ({
  db,
  reference,
}: Omit<Cutover, "statements">): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const statements = yield* prepareCutover(db);
    yield* refuseMissingDecision({ db, reference, statements });
    const before = yield* Effect.tryPromise(() => snapshot(db));
    yield* Effect.tryPromise(() =>
      expect(
        db.batch([
          ...statements.map((sql) => db.prepare(sql)),
          db.prepare(
            "INSERT INTO sql_assertions(scope,accepted) VALUES('handoff-cutover-fault',0)"
          ),
        ])
      ).rejects.toThrow("CHECK constraint failed")
    );
    expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
      before.map((table) => table.results)
    );
    yield* Effect.tryPromise(() => db.batch(statements.map((sql) => db.prepare(sql))));
    expect(
      (yield* Effect.tryPromise(() => snapshot(db))).slice(0, -1).map((table) => table.results)
    ).toEqual(before.slice(0, -1).map((table) => table.results));
  });
