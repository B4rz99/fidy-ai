import { afterAll, expect, it } from "vitest";
import { Data, Effect } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const native = <A>(run: () => PromiseLike<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new FixtureFailure({ cause }),
  });
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const current = 1_800_000_000_123;

const disclosure = ' { "revision": "original", "text": "Sí, autorización exacta" } ';
const id = (ordinal: number): string =>
  `14390000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

it("preserves the originating disclosure basis and decision of accepted and declined Consent exchanges", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      for (const [ordinal, decision] of [
        [3, "accepted"],
        [9, "declined"],
      ] as const) {
        yield* native(() =>
          db.batch([
            db
              .prepare(`INSERT INTO pending_consent_exchanges
              (id,portfolio_id,bsuid,phone_number_id,initiating_message_id,initiating_body_sha256,correlation_token,
               disclosure_json,created_at_ms,expires_at_ms,state)
              VALUES(?,'portfolio',?,'123456789',?,?,?, ?,?,?,'awaiting_delivery')`)
              .bind(
                id(ordinal),
                `recipient-${ordinal}`,
                `first-${ordinal}`,
                "a".repeat(64),
                id(ordinal),
                disclosure,
                current,
                current + 86400000
              ),
            db
              .prepare(
                "UPDATE pending_consent_exchanges SET state='outbound_started',disclosure_message_id='disclosed' WHERE id=?"
              )
              .bind(id(ordinal)),
            db
              .prepare(`UPDATE pending_consent_exchanges SET delivery_phone_number_id='123456789',delivery_message_id='disclosed',
              delivery_occurred_at_ms=?,delivery_received_at_ms=?,delivery_not_before_ms=? WHERE id=?`)
              .bind(current + 1000, current + 2010, current + 5010, id(ordinal)),
            db
              .prepare(`UPDATE pending_consent_exchanges SET decision_value=?,decision_message_id=?,decision_delivery_key=?,
              decision_body_sha256=?,decision_occurred_at_ms=?,decision_received_at_ms=? WHERE id=?`)
              .bind(
                decision,
                `decision-${ordinal}`,
                `key-${ordinal}`,
                "b".repeat(64),
                current + 6000,
                current + 6017,
                id(ordinal)
              ),
          ])
        );
      }
      const read = (): Promise<D1Result> =>
        db.prepare("SELECT * FROM pending_consent_exchanges ORDER BY id").all();
      const before = (yield* native(read)).results;
      expect(before).toMatchObject([
        { state: "accepted", decision_value: "accepted", disclosure_json: disclosure },
        { state: "declined", decision_value: "declined", disclosure_json: disclosure },
      ]);
      for (const mutation of [
        "portfolio_id='changed'",
        "disclosure_json='{}'",
        "disclosure_message_id='changed'",
        "decision_value=NULL,decision_message_id=NULL,decision_delivery_key=NULL,decision_body_sha256=NULL,decision_occurred_at_ms=NULL,decision_received_at_ms=NULL",
      ]) {
        expect(
          (yield* Effect.exit(
            native(() =>
              db
                .prepare(
                  `UPDATE pending_consent_exchanges SET ${mutation} WHERE decision_value IS NOT NULL`
                )
                .run()
            )
          ))._tag
        ).toBe("Failure");
        expect((yield* native(read)).results).toEqual(before);
      }
    })
  ));
