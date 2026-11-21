import { canonicalRetryLifetimeMs } from "../../src/core/quotas/contract";
import { canonicalRequestProtection } from "../canonical-admission/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { nativePurgePlatform } from "../user-store.test-fixture";
import {
  alice,
  makeNativeTransactionJourney,
  type nativeTransactionJourney,
} from "../financial-user-store.test-fixture";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";
import { TestClock } from "effect/testing";
import { RecurringSeriesPage } from "../../src/core/recurring/contract";
import { Transaction } from "../../src/core/transactions/contract";

const fromPromise = <A>(run: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise(() => Promise.resolve(run())).pipe(Effect.orDie);

const verifyCaptureWake = Effect.fn(function* (
  db: Effect.Success<typeof nativeTransactionJourney>
) {
  const users = yield* fromPromise(() =>
    db.runtime.getDurableObjectNamespace("USER_STORE", "core")
  );

  const alarm = Effect.fnUntraced(function* () {
    return yield* fromPromise(() =>
      users
        .getByName(alice.user)
        .fetch("https://fixture.invalid/storage")
        .then((response) => response.json())
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ alarm: Schema.Int }))));
  });

  const due = yield* Schema.decodeUnknownEffect(
    Schema.NonEmptyArray(Schema.Struct({ facts: Schema.Int, bucket: Schema.Int }))
  )(
    yield* fromPromise(() =>
      db.exec(
        "SELECT min(created_at_ms)+3600000 AS facts,(SELECT min(virtual_at_ms)+60000 FROM canonical_request_buckets) AS bucket FROM transactions WHERE user_id=?",
        alice.user
      )
    )
  );

  expect((yield* alarm()).alarm).toBe(due[0].facts);
  expect(due[0].bucket).toBeLessThan(due[0].facts);
  expect(yield* fromPromise(() => db.checkWork(alice.user))).toEqual({
    status: 204,
    repaired: "1",
  });
  expect((yield* alarm()).alarm).toBe(due[0].bucket);
  yield* fromPromise(() =>
    db.exec(
      "INSERT INTO canonical_request_receipts SELECT user_id,?,'transactions.createTransaction',?,?,200,NULL FROM transactions WHERE user_id=? LIMIT 1",
      "a".repeat(64),
      "b".repeat(64),
      due[0].bucket - canonicalRetryLifetimeMs,
      alice.user
    )
  );
  expect(yield* fromPromise(() => db.checkWork(alice.user))).toEqual({
    status: 204,
    repaired: "0",
  });
  yield* fromPromise(() =>
    db.exec("UPDATE canonical_request_receipts SET accepted_at_ms=accepted_at_ms-1")
  );
  expect(yield* fromPromise(() => db.checkWork(alice.user))).toEqual({
    status: 204,
    repaired: "1",
  });
  expect((yield* alarm()).alarm).toBe(due[0].bucket - 1);
  yield* fromPromise(() => db.exec("DELETE FROM canonical_request_receipts"));
});

const historicalPatternJourney = Effect.gen(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform).pipe(
    TestClock.withLive
  );

  yield* fromPromise(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',0)",
      alice.session,
      alice.user
    )
  );

  const request = (path: string, method = "GET", payload?: unknown): Effect.Effect<Response> =>
    TestClock.withLive(Effect.sleep(canonicalRequestProtection.intervalMs)).pipe(
      Effect.andThen(
        fromPromise(() =>
          db.send(
            new Request(`https://api.fidyapp.com${path}`, {
              method,
              headers: {
                origin: "https://app.fidyapp.com",
                "content-type": "application/json",
                "Fidy-Session-Binding": alice.session,
                cookie: `__Host-fidy_session=${alice.bearer}`,
              },
              body: payload === undefined ? null : JSON.stringify(payload),
            })
          )
        )
      )
    );

  const evaluateDue = Effect.fn(function* () {
    yield* fromPromise(() =>
      db.exec(
        "UPDATE recurring_evaluation_records SET evaluated_at_ms=0 WHERE kind='progress' AND phase='complete'"
      )
    );
    yield* fromPromise(() =>
      db.exec(
        "UPDATE transaction_projection_state SET first_captured_at_ms=0 WHERE fact_revision IS NOT NULL"
      )
    );
    yield* TestClock.withLive(
      Effect.gen(function* () {
        expect((yield* fromPromise(() => db.checkWork(alice.user))).status).toBe(204);

        return yield* fromPromise(() =>
          db.exec(
            "SELECT 1 AS ready FROM recurring_evaluation_records p JOIN transaction_projection_state f USING(user_id) WHERE p.kind='progress' AND p.phase='complete' AND p.evaluated_revision=f.fact_revision"
          )
        );
      }).pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("10 seconds"),
        Effect.orDie
      )
    );
  });

  const read = (): Effect.Effect<typeof RecurringSeriesPage.Type> =>
    Effect.gen(function* () {
      const response = yield* request("/recurring-series");
      expect(response.status).toBe(200);

      return (yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
      )(yield* fromPromise(() => response.json())).pipe(Effect.orDie)).data;
    });

  const created: Array<Transaction> = yield* Effect.forEach([1, 2, 3], (month) =>
    Effect.gen(function* () {
      const response = yield* request("/transactions", "POST", {
        money: { amount: "30000.25", currency: "COP" },
        counterparty: "Netflix",
        direction: "outflow",
        categoryId: "10000000-0000-4000-8000-000000000016",
        occurredAt: `2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`,
      });

      expect(response.status).toBe(201);

      return (yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(Schema.Struct({ data: Transaction }))
      )(yield* fromPromise(() => response.json())).pipe(Effect.orDie)).data;
    })
  );

  yield* verifyCaptureWake(db);
  yield* evaluateDue();
  const initial = yield* read();
  expect(initial.evaluation.kind).toBe("current");
  expect(initial.series).toHaveLength(1);
  const original = initial.series[0];
  const middle = created[1];

  if (original === undefined || middle === undefined) {
    return yield* Effect.die("Missing captured pattern");
  }

  const correction = yield* request(`/transactions/${middle.id}`, "PUT", {
    expectedRevision: 0,
    changes: { counterparty: null },
  });

  expect(correction.status).toBe(200);
  expect((yield* read()).evaluation.kind).toBe("updating");
  yield* evaluateDue();
  expect((yield* read()).series).toHaveLength(0);

  const restored = yield* request(`/transactions/${middle.id}`, "PUT", {
    expectedRevision: 1,
    changes: { counterparty: "Netflix" },
  });

  expect(restored.status).toBe(200);
  yield* evaluateDue();
  expect((yield* read()).series).toEqual([original]);
  const deleted = yield* request(`/transactions/${middle.id}`, "DELETE");
  expect(deleted.status).toBe(200);
  yield* evaluateDue();
  expect((yield* read()).series).toHaveLength(0);
});

const pagedSeriesJourney = Effect.gen(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativePurgePlatform).pipe(
    TestClock.withLive
  );

  const user = alice.user;
  yield* fromPromise(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',0)",
      alice.session,
      user
    )
  );

  const owner = (yield* fromPromise(() =>
    db.runtime.getDurableObjectNamespace("USER_STORE", "core")
  )).getByName(user);

  const fixed = Date.UTC(2026, 9, 20),
    captured = Date.UTC(2025, 10, 1);

  const advance = (): Effect.Effect<number> =>
    fromPromise(() =>
      owner.fetch("https://fixture.invalid/user-alarm", {
        method: "POST",
        headers: { "fixture-clock": String(fixed) },
      })
    ).pipe(Effect.map((reply) => reply.status));

  const progress = (): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
    fromPromise(() =>
      db.exec(
        "SELECT phase,revision,evaluated_revision FROM recurring_evaluation_records WHERE kind='progress'"
      )
    );

  const seed = Effect.fn(function* (first: number, last: number) {
    yield* fromPromise(() =>
      db.exec(
        `WITH RECURSIVE groups(i) AS (SELECT ? UNION ALL SELECT i+1 FROM groups WHERE i<?), months(m) AS(VALUES(1),(2),(3))
     INSERT INTO transactions(user_id,id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)
     SELECT ?,printf('70000000-0000-4000-8000-%012d',i*10+m),'333','COP','outflow',printf('Merchant %03d',i),'10000000-0000-4000-8000-000000000016',unixepoch(printf('2026-%02d-15 12:00:00',m))*1000,? FROM groups,months`,
        first,
        last,
        user,
        captured
      )
    );
    yield* fromPromise(() =>
      db.exec(
        "INSERT OR REPLACE INTO transaction_projection_leaf(user_id,id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,revision,category_revision) SELECT user_id,id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,revision,category_revision FROM transaction_effective_source"
      )
    );
    yield* fromPromise(() =>
      db.exec(
        `INSERT INTO transaction_projection_state(user_id,version,readiness,fact_revision,first_captured_at_ms,time_zone) VALUES(?,1,'ready',?,?,'America/Bogota') ON CONFLICT(user_id) DO UPDATE SET fact_revision=excluded.fact_revision,first_captured_at_ms=excluded.first_captured_at_ms,readiness='ready',version=1,time_zone='America/Bogota'`,
        user,
        last,
        captured
      )
    );
    yield* fromPromise(() =>
      db.exec(
        "UPDATE recurring_evaluation_records SET evaluated_at_ms=0 WHERE kind='progress' AND phase='complete'"
      )
    );
  });

  const finishStep = (revision: number, step: number): Effect.Effect<number, Schema.SchemaError> =>
    Effect.gen(function* () {
      if (step >= revision + 30) {
        return yield* Effect.die("User alarm did not finish bounded recurring discovery");
      }

      const status = yield* advance();

      if (status !== 204) return status;

      const [record] = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ phase: Schema.String, evaluated_revision: Schema.Int }))
      )(yield* progress());

      if (record?.phase === "complete" && record.evaluated_revision === revision) return status;

      return yield* finishStep(revision, step + 1);
    });

  const finish = (revision: number): Effect.Effect<number, Schema.SchemaError> =>
    finishStep(revision, 0);

  yield* seed(1, 33);
  expect(yield* advance()).toBe(204);
  expect(yield* advance()).toBe(204);
  yield* fromPromise(() => db.exec("UPDATE transaction_projection_state SET fact_revision=34"));
  expect(yield* finish(34)).toBe(204);

  const read = Effect.fn(function* (path: string) {
    const res = yield* fromPromise(() => db.browser(0, path));
    expect(res.status).toBe(200);

    return (yield* Schema.decodeUnknownEffect(
      Schema.toCodecJson(Schema.Struct({ data: RecurringSeriesPage }))
    )(yield* fromPromise(() => res.json()))).data;
  });

  const first = yield* read("/recurring-series");
  expect(first.series.length).toBe(32);
  const cursor = Option.getOrThrow(first.cursor);
  const last = yield* read("/recurring-series?cursor=" + encodeURIComponent(cursor));
  expect(last.series.length).toBe(1);
  expect(last.cursor).toEqual(Option.none());
  expect(new Set([...first.series, ...last.series].map((item) => item.id)).size).toBe(33);
  yield* seed(34, 128);
  expect(yield* finish(128)).toBe(204);
  expect(
    (yield* fromPromise(() =>
      db.browser(0, "/recurring-series?cursor=" + encodeURIComponent(cursor))
    )).status
  ).toBe(400);
  const count = "SELECT count(*) n FROM recurring_series WHERE valid=1";
  expect(yield* fromPromise(() => db.exec(count))).toEqual([{ n: 128 }]);
  yield* seed(129, 129);
  expect(yield* finish(129)).toBe(503);
  expect(yield* fromPromise(() => db.exec(count))).toEqual([{ n: 128 }]);
  expect((yield* read("/recurring-series")).evaluation.kind).toBe("updating");
});

it.layer(NodeFileSystem.layer)((nativeTest) => {
  nativeTest.effect(
    "public capture, correction and deletion invalidate and repair the same historical pattern",
    () => historicalPatternJourney,
    { timeout: 30_000 }
  );
  nativeTest.effect(
    "restarts a changed native evaluation, pages published series and withholds 129 proposals above its 128-series bound",
    () => pagedSeriesJourney,
    { timeout: 90_000 }
  );
});
