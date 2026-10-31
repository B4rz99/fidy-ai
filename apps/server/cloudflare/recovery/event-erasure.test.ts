import { afterAll, expect, it } from "vitest";
import { Data, Effect, Option } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeRecoveryErasureStores } from "./runtime";
import type { ErasureUnavailable } from "../erasure-store/contract";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 1_800_000_000_123;
const recordId = (ordinal: number): string =>
  `14420000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const owner = "14420000-0000-4000-8000-000000000001";
const foreign = "14420000-0000-4000-8000-000000000002";
const requestId = "14420000-0000-4000-8000-000000000003";
const seed = (db: D1Database): Promise<ReadonlyArray<D1Result>> =>
  db.batch([
    ...[owner, foreign].map((userId) =>
      db
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES(?,'CO','es-CO','America/Bogota',1)"
        )
        .bind(userId)
    ),
    ...[owner, foreign].flatMap((userId, index) => [
      db
        .prepare(
          "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,'consumed',?,?)"
        )
        .bind(
          recordId(10 + index),
          index === 0 ? "BCDF-GHJK" : "BCDF-HJKM",
          userId,
          current - 1000,
          current + 599000
        ),
      db
        .prepare(
          "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms,opened_event_id,opened_event_row_ref,decision_event_id,decision_event_row_ref) VALUES(?,?,?,'original-issuer','original-operator',3,?,?,'approved',?,?,?,?,?)"
        )
        .bind(
          `case-${index}`,
          userId,
          recordId(10 + index),
          current - 500,
          current + 599000,
          current - 100,
          `event-${index}-0`,
          String(10 + index * 10),
          `event-${index}-1`,
          String(11 + index * 10)
        ),
    ]),
  ]);
const eventMetadataErasure = (
  db: D1Database
): Effect.Effect<void, FixtureFailure | ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* native(() =>
      db.batch(
        Array.from({ length: 32 }, (_, index) => [
          db
            .prepare(
              "INSERT INTO browser_login_pairings(id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms) VALUES(?,?,randomblob(32),?,'consumed',?,?)"
            )
            .bind(
              recordId(100 + index),
              String(index).padStart(9, "B"),
              owner,
              current - 1000,
              current + 599000
            ),
          db
            .prepare(
              "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms,opened_event_id,opened_event_row_ref,decision_event_id,decision_event_row_ref) VALUES(?,?,?,'original-issuer','batch-operator',3,?,?,'approved',?,?,?,?,?)"
            )
            .bind(
              recordId(200 + index),
              owner,
              recordId(100 + index),
              current - 500,
              current + 599000,
              current - 100,
              `opened-${index}`,
              String(1000 + index * 2),
              `decided-${index}`,
              String(1001 + index * 2)
            ),
        ]).flat()
      )
    );
    const before = yield* native(() =>
      db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()
    );
    yield* native(() =>
      expect(
        db
          .prepare(
            "INSERT INTO support_recovery_cases(id,user_id,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms) SELECT 'forged',?,pairing_id,operator_issuer,operator_subject,credential_revision,opened_at_ms,expires_at_ms,state,closed_at_ms FROM support_recovery_cases WHERE id='case-0'"
          )
          .bind(foreign)
          .run()
      ).rejects.toThrow("recovery_case_owner")
    );
    yield* native(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state) VALUES(?,?,1,'Draining')"
          )
          .bind(requestId, owner),
        db
          .prepare(
            "INSERT INTO erasure_steps(request_id,store_id) VALUES(?,'support_recovery_events')"
          )
          .bind(requestId),
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(requestId),
      ])
    );
    const store = makeRecoveryErasureStores(db).find(
      (entry) => entry.id === "support_recovery_events"
    );
    if (store === undefined) throw Error("Missing recovery metadata erasure");
    const scope = { userId: owner, reference: requestId };

    yield* native(() =>
      db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(requestId).run()
    );
    expect(
      (yield* Effect.result(store.remove({ reference: requestId, userId: foreign })))._tag
    ).toBe("Failure");
    yield* native(() =>
      expect(
        db
          .prepare(
            "UPDATE support_recovery_cases SET opened_event_id=NULL,opened_event_row_ref=NULL WHERE user_id=?"
          )
          .bind(owner)
          .run()
      ).rejects.toThrow("recovery_case_immutable")
    );
    yield* native(() =>
      expect(
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_permits(request_id,user_id,store_id) VALUES(?,?,'support_recovery_cases')"
            )
            .bind(requestId, owner),
          db.prepare("DELETE FROM support_recovery_cases WHERE user_id=?").bind(owner),
        ])
      ).rejects.toThrow("erasure_fenced")
    );
    yield* native(() =>
      db
        .prepare(
          "CREATE TRIGGER interrupt_recovery_metadata AFTER UPDATE ON support_recovery_cases BEGIN SELECT RAISE(ABORT,'interrupted metadata removal');END"
        )
        .run()
    );
    expect((yield* Effect.result(store.remove(scope)))._tag).toBe("Failure");
    expect(
      (yield* native(() => db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()))
        .results
    ).toEqual(before.results);
    yield* native(() => db.prepare("DROP TRIGGER interrupt_recovery_metadata").run());
    expect(yield* store.remove(scope)).toBe(false);
    expect(
      yield* native(() =>
        db
          .prepare(
            "SELECT sum((opened_event_id IS NOT NULL)+(decision_event_id IS NOT NULL)) AS remaining FROM support_recovery_cases WHERE user_id=?"
          )
          .bind(owner)
          .first("remaining")
      )
    ).toBe(2);
    const resumed = Option.getOrThrow(
      Option.fromUndefinedOr(
        makeRecoveryErasureStores(db).find((entry) => entry.id === "support_recovery_events")
      )
    );
    expect(yield* resumed.remove(scope)).toBe(true);
    expect(yield* resumed.remove(scope)).toBe(true);
    const after = yield* native(() =>
      db.prepare("SELECT * FROM support_recovery_cases ORDER BY rowid").all()
    );
    expect(after.results).toEqual(
      before.results.map((row) =>
        row.user_id === owner
          ? {
              ...row,
              opened_event_id: null,
              opened_event_row_ref: null,
              decision_event_id: null,
              decision_event_row_ref: null,
            }
          : row
      )
    );
    expect(
      (yield* native(() => db.prepare("SELECT * FROM erasure_permits").all())).results
    ).toEqual([]);
  });
it("erases recovery event metadata in bounded pages with rollback, resumption and User isolation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() => seed(db));
      yield* eventMetadataErasure(db);
    })
  ));
