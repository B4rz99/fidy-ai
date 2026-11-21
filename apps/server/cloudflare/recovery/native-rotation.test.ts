import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { BackupRecoveryCode } from "../../src/core/recovery/contract";

const setup = Effect.gen(function* () {
  const db = yield* nativeTransactionJourney;
  const now = yield* Clock.currentTimeMillis;
  const digest = new Uint8Array(32);
  yield* native(() =>
    db.exec(
      "INSERT INTO backup_recovery_credentials(user_id,code_digest,revision,created_at_ms) VALUES(?,?,1,?)",
      alice.user,
      digest.buffer,
      now
    )
  );
  yield* native(() =>
    db.directory.exec(
      "INSERT INTO recovery_routes(code_digest,user_id,attempt_id,revision,generation) VALUES(?,?,?,1,1)",
      digest.buffer,
      alice.user,
      "original"
    )
  );

  const rotate = (binding: string): Effect.Effect<Response> =>
    native(() =>
      db.send(
        new Request("https://api.fidyapp.com/recovery/backup-code/rotate", {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": binding,
          },
        })
      )
    );

  return { db, rotate };
});

const scenario = Effect.gen(function* () {
  const { db, rotate } = yield* setup;
  expect((yield* rotate(bob.session)).status).toBe(401);
  const freshness = yield* native(() => db.exec("SELECT fresh_until_ms FROM web_sessions"));
  const won = yield* rotate(alice.session);
  expect(won.status).toBe(200);

  const read = (
    response: Response
  ): Effect.Effect<
    { readonly data: { readonly backupRecoveryCode: BackupRecoveryCode } },
    Schema.SchemaError
  > =>
    native(() => response.json()).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ backupRecoveryCode: BackupRecoveryCode }) })
        )
      )
    );

  const first = yield* read(won);
  yield* native(() =>
    db.directory.exec(
      "CREATE TRIGGER hold_retirement BEFORE DELETE ON recovery_routes BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  const second = yield* read(yield* rotate(alice.session));
  expect(
    yield* native(() =>
      db.directory.exec(
        "SELECT revision FROM recovery_routes WHERE user_id=? ORDER BY revision",
        alice.user
      )
    )
  ).toEqual([{ revision: 2 }, { revision: 3 }]);
  yield* native(() => db.directory.exec("DROP TRIGGER hold_retirement"));
  yield* native(() => db.checkWork(alice.user));
  yield* Effect.forEach(Array.from({ length: 15 }), () =>
    Effect.gen(function* () {
      const rows = yield* native(() =>
        db.directory.exec("SELECT revision FROM recovery_routes WHERE user_id=?", alice.user)
      );

      if (rows.length > 1) yield* Effect.sleep("30 millis");
    })
  );
  expect(yield* native(() => db.exec("SELECT fresh_until_ms FROM web_sessions"))).toEqual(
    freshness
  );
  expect(second.data.backupRecoveryCode).not.toBe(first.data.backupRecoveryCode);
  expect(
    yield* native(() =>
      db.directory.exec("SELECT revision FROM recovery_routes WHERE user_id=?", alice.user)
    )
  ).toEqual([{ revision: 3 }]);
  yield* native(() =>
    db.exec(
      "UPDATE web_sessions SET created_at_ms=created_at_ms-610000,fresh_until_ms=fresh_until_ms-610000,hard_expires_at_ms=hard_expires_at_ms-610000"
    )
  );
  expect((yield* rotate(alice.session)).status).toBe(403);
  expect(yield* native(() => db.exec("SELECT revision FROM backup_recovery_credentials"))).toEqual([
    { revision: 3 },
  ]);
});

const fenceFailure = Effect.fn(function* (failure: "revision" | "evidence") {
  const { db, rotate } = yield* setup;

  const trigger =
    failure === "revision"
      ? "CREATE TRIGGER change_revision AFTER INSERT ON recovery_rotations BEGIN UPDATE backup_recovery_credentials SET revision=revision+1; END"
      : "CREATE TRIGGER fail_evidence BEFORE INSERT ON audit_entries WHEN NEW.record_type='security_mutation' BEGIN SELECT RAISE(IGNORE); END";

  yield* native(() => db.exec(trigger));
  expect((yield* rotate(alice.session)).status).toBe(failure === "revision" ? 401 : 503);
  expect(
    yield* native(() =>
      db.exec("SELECT hex(code_digest) AS original FROM backup_recovery_credentials")
    )
  ).toEqual([{ original: "00".repeat(32) }]);
  expect(
    yield* native(() =>
      db.exec("SELECT id FROM audit_entries WHERE record_type='security_mutation'")
    )
  ).toEqual([]);
});

const lostAcknowledgement = Effect.gen(function* () {
  const { db, rotate } = yield* setup;
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER hold_ack BEFORE DELETE ON recovery_rotations BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END"
    )
  );
  expect((yield* rotate(alice.session)).status).toBe(200);
  expect(yield* native(() => db.exec("SELECT state FROM recovery_rotations"))).toEqual([
    { state: "committed" },
  ]);
  yield* native(() => db.directory.exec("DELETE FROM recovery_rotations WHERE state='committed'"));
  yield* native(() => db.exec("UPDATE recovery_rotations SET expires_at_ms=0"));
  yield* native(() => db.exec("DROP TRIGGER hold_ack"));
  yield* native(() => db.checkWork(alice.user));

  const outstanding = yield* native(() => db.exec("SELECT id FROM recovery_rotations")).pipe(
    Effect.repeat({
      until: (rows) => rows.length === 0,
      schedule: Schedule.spaced("50 millis"),
      times: 20,
    })
  );

  expect(outstanding).toEqual([]);
  expect(
    yield* native(() =>
      db.directory.exec("SELECT revision FROM recovery_routes WHERE user_id=?", alice.user)
    )
  ).toEqual([{ revision: 2 }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("fences a delayed rotation after the observed revision changes", () =>
    fenceFailure("revision")
  );
  test.effect("rolls rotation back with required security evidence", () =>
    fenceFailure("evidence")
  );
  test.effect(
    "settles an already collected rotation after losing the directory acknowledgement",
    () => lostAcknowledgement
  );
  test.effect(
    "rotates only the fresh session owner's exact revision and discloses each code once",
    () => scenario
  );
});
