import { redeemBrowserPairing } from "../browser-login/operations";
import { Effect, Schema } from "effect";
import type { Cause } from "effect";
import { expect } from "vitest";
import {
  documentedSqlBlock,
  installHistoricalErasureChunk,
  schemaDefinition,
  schemaStatements,
} from "../schema-cutover.test-fixture";
import { observeRetentionCost } from "../d1-test-fixture";
import { sweepProviderAuthentication } from "./runtime";

const wrongVerifierBudget = 5;
const privateVerifierLength = 43;
const invalidProofStatus = 400;

type Cutover = Readonly<{
  db: D1Database;
  pairingId: string;
  subject: string;
  cutover: ReadonlyArray<string>;
}>;
const snapshot = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[
      "users",
      "provider_credentials",
      "provider_authentication_attempts",
      "backup_recovery_credentials",
      "consent_history",
      "browser_login_pairings",
      "web_sessions",
      "erasure_archives",
    ].map((table) => db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`)),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name"),
  ]);

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
        Bun.file(new URL("./ownership-before-1444.fixture.sql", import.meta.url)).text()
      )
    );
    const guide = yield* Effect.tryPromise(() =>
      Bun.file(
        new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
      ).text()
    );
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("DROP TRIGGER provider_credential_immutable"),
        db.prepare("DROP TRIGGER provider_completion_immutable"),
        ...prior.map((sql) => db.prepare(sql)),
      ])
    );
    return [
      ...documentedSqlBlock({ guide, marker: "provider-onboarding-preflight" }),
      "DROP TRIGGER provider_completion_immutable",
      ...["provider_credential_immutable", "provider_completion_immutable"].map((target) =>
        schemaDefinition({ source: baseline, target })
      ),
      "DELETE FROM sql_assertions WHERE scope='provider_onboarding_cutover'",
    ];
  });
const refuseConflictingHistory = ({
  db,
  pairingId,
  subject,
  cutover,
}: Cutover): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "UPDATE provider_authentication_attempts SET subject='another-subject' WHERE pairing_id=?"
        )
        .bind(pairingId)
        .run()
    );
    const conflicting = yield* Effect.tryPromise(() => snapshot(db));
    yield* Effect.tryPromise(() =>
      expect(db.batch(cutover.map((sql) => db.prepare(sql)))).rejects.toThrow(
        "CHECK constraint failed"
      )
    );
    expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
      conflicting.map((table) => table.results)
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE provider_authentication_attempts SET subject=? WHERE pairing_id=?")
        .bind(subject, pairingId)
        .run()
    );
  });
/** Exercise the installed guard cutover on records created through the provider journey. */
export const verifyProviderOwnershipCutover = ({
  db,
  pairingId,
  subject,
}: Omit<Cutover, "cutover">): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < wrongVerifierBudget; attempt++) {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        pairingId,
        privateVerifier: "x".repeat(privateVerifierLength),
      });
      expect(
        (yield* redeemBrowserPairing({
          db,
          request: new Request("https://api.fidyapp.com/web/pairings/redeem", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        })).status
      ).toBe(invalidProofStatus);
    }
    const cutover = yield* prepareCutover(db);
    yield* refuseConflictingHistory({ db, pairingId, subject, cutover });
    const before = yield* Effect.tryPromise(() => snapshot(db));
    yield* Effect.tryPromise(() =>
      expect(
        db.batch([
          ...cutover.map((sql) => db.prepare(sql)),
          db.prepare(
            "INSERT INTO sql_assertions(scope,accepted) VALUES('provider-cutover-fault',0)"
          ),
        ])
      ).rejects.toThrow("CHECK constraint failed")
    );
    expect((yield* Effect.tryPromise(() => snapshot(db))).map((table) => table.results)).toEqual(
      before.map((table) => table.results)
    );
    yield* Effect.tryPromise(() => db.batch(cutover.map((sql) => db.prepare(sql))));
    expect(
      (yield* Effect.tryPromise(() => snapshot(db))).slice(0, -1).map((table) => table.results)
    ).toEqual(before.slice(0, -1).map((table) => table.results));
    const observed = observeRetentionCost(db);
    yield* sweepProviderAuthentication({ db: observed.database, current: 0 }).pipe(Effect.orDie);
    expect(
      (yield* Effect.tryPromise(observed.plans)).some(
        (plan) => plan.includes("provider_attempt_expiry") && plan.includes("expires_at_ms<?")
      )
    ).toBe(true);
  });
