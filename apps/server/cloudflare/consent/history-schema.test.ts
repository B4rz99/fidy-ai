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

it("allocates new Consent history after its retained high-water mark and rejects evidence changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* native(() => databases.acquire());
      yield* native(() => installTestSchema({ db }));
      yield* native(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES('14380000-0000-4000-8000-000000000001','CO','es-CO','America/Bogota',?)"
            )
            .bind(current),
          db
            .prepare(
              "INSERT INTO consent_offers(id,user_id,kind,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('14380000-0000-4000-8000-000000000007','14380000-0000-4000-8000-000000000001','weekly-summary','portfolio','recipient','{}',?,?)"
            )
            .bind(current, current + 600000),
          db.prepare(
            "INSERT INTO consent_history(sequence,record_type,id,user_id,offer_id,decision_message_id,decision) VALUES(7,'weekly_rejection','original','14380000-0000-4000-8000-000000000001','14380000-0000-4000-8000-000000000007','original-choice','decline')"
          ),
          db.prepare("UPDATE sqlite_sequence SET seq=101 WHERE name='consent_history'"),
        ])
      );
      yield* native(() =>
        db
          .prepare(
            "INSERT INTO consent_history(record_type,id,user_id,offer_id,decision_message_id,decision) VALUES('weekly_rejection','next','14380000-0000-4000-8000-000000000001','14380000-0000-4000-8000-000000000007','next-choice','decline')"
          )
          .run()
      );
      expect(
        yield* native(() =>
          db.prepare("SELECT sequence FROM consent_history WHERE id='next'").first()
        )
      ).toEqual({ sequence: 102 });
      const read = (): Promise<D1Result> =>
        db.prepare("SELECT * FROM consent_history ORDER BY sequence").all();
      const before = (yield* native(read)).results;
      for (const sql of [
        "UPDATE consent_history SET decision='revoke' WHERE sequence=7",
        "DELETE FROM consent_history WHERE sequence=7",
      ]) {
        expect((yield* Effect.exit(native(() => db.prepare(sql).run())))._tag).toBe("Failure");
        expect((yield* native(read)).results).toEqual(before);
      }
    })
  ));
