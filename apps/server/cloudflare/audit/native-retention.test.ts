import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule } from "effect";
import { expect } from "vitest";
import { auditRetentionDays, utcDayMilliseconds } from "../../src/shell/audit/contract";
import {
  alice,
  bob,
  makeNativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { native, nativePurgePlatform } from "../user-store.test-fixture";

const retention = Effect.gen(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform);
  const now = (yield* Clock.currentTimeMillis) + 450 * utcDayMilliseconds;

  const count =
    "SELECT count(*) n FROM audit_entries WHERE operation='transactions.listTransactions' AND id LIKE 'retention-%'";

  const seed = Effect.fn(function* (who: typeof alice) {
    yield* native(() =>
      db
        .owner(who.user)
        .exec(
          "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<65) INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms) SELECT 'retention-'||x,?,?,'session_call','transactions.listTransactions','success',? FROM n",
          who.user,
          who.session,
          now - (auditRetentionDays + 1) * utcDayMilliseconds
        )
    );
    yield* native(() =>
      db
        .owner(who.user)
        .exec(
          "INSERT INTO audit_entries(id,user_id,session_id,record_type,occurred_at_ms) VALUES('security-retained',?,?,'identity_read',?)",
          who.user,
          who.session,
          now - 400 * utcDayMilliseconds
        )
    );
  });

  yield* seed(alice);
  yield* seed(bob);
  expect(
    (yield* Effect.exit(native(() => db.exec("DELETE FROM audit_entries WHERE id='retention-1'"))))
      ._tag
  ).toBe("Failure");
  expect(yield* native(() => db.exec(count))).toEqual([{ n: 65 }]);
  const users = yield* native(() => db.runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const owner = users.getByName(alice.user);

  const alarm = Effect.fn(function* () {
    return yield* native(() =>
      owner.fetch("https://fixture.invalid/user-alarm", {
        method: "POST",
        headers: { "fixture-clock": String(now) },
      })
    );
  });

  yield* seedNativePAT({
    db,
    userId: alice.user,
    token: "fin_aaaaaaaa_" + "c".repeat(43),
    scopes: ["read"],
    current: now,
  });

  const admission = Effect.fn(function* (id: string, at: number) {
    return yield* native(() =>
      db.exec(
        "INSERT INTO audit_entries(id,user_id,pat_id,record_type,operation,occurred_at_ms) SELECT ?,user_id,id,'request_admission','transactions.listTransactions',? FROM pats WHERE short_id='aaaaaaaa'",
        id,
        at
      )
    );
  });

  yield* admission("admission-old", now - 93 * utcDayMilliseconds);
  yield* admission("admission-new", now - 93 * utcDayMilliseconds + 1);
  yield* native(() =>
    db.exec(
      "INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms) VALUES('ordinary-boundary',?,?,'session_call','transactions.listTransactions','success',?)",
      alice.user,
      alice.session,
      now - 365 * utcDayMilliseconds
    )
  );

  yield* native(() =>
    db.exec(
      "CREATE TRIGGER keep_permit BEFORE DELETE ON audit_retention_permits BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  yield* alarm();
  expect(yield* native(() => db.exec(count))).toEqual([{ n: 65 }]);
  expect(yield* native(() => db.exec("SELECT user_id FROM audit_retention_permits"))).toEqual([]);
  yield* native(() => db.exec("DROP TRIGGER keep_permit"));
  yield* native(() => db.checkWork(alice.user));
  yield* native(() =>
    db.exec("ALTER TABLE canonical_request_receipts RENAME TO fixture_missing_receipts")
  );
  expect((yield* alarm()).status).toBe(503);
  expect(yield* native(() => db.exec(count))).toEqual([{ n: 1 }]);
  yield* native(() =>
    db.exec("ALTER TABLE fixture_missing_receipts RENAME TO canonical_request_receipts")
  );
  expect((yield* alarm()).status).toBe(204);

  const retained = yield* native(() => db.exec(count)).pipe(
    Effect.repeat({
      until: (rows) => rows[0]?.n === 0,
      times: 50,
      schedule: Schedule.spaced("50 millis"),
    })
  );

  expect(retained).toEqual([{ n: 0 }]);
  expect(
    yield* native(() => db.exec("SELECT id FROM audit_entries WHERE id='security-retained'"))
  ).toEqual([{ id: "security-retained" }]);
  expect(
    yield* native(() =>
      db.exec(
        "SELECT id FROM audit_entries WHERE id IN ('ordinary-boundary','admission-old','admission-new') ORDER BY id"
      )
    )
  ).toEqual([{ id: "admission-new" }, { id: "ordinary-boundary" }]);
  expect(yield* native(() => db.owner(bob.user).exec(count))).toEqual([{ n: 65 }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "uses the User alarm to retain ordinary Audit and admission evidence at separate deadlines without touching another User or security evidence",
    () => retention
  );
});
