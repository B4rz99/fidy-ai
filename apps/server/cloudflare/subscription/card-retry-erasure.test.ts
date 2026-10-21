import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { afterAll, expect, it } from "vitest";
import { Clock, Effect, Schema } from "effect";
import { makeSubscriptionErasureStores } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const foreignUser = "10000000-0000-4000-8000-000000000002";
const reference = "10000000-0000-4000-8000-000000000003";
const foreignReference = "10000000-0000-4000-8000-000000000004";
const id = (kind: number, index: number): string =>
  `${kind}0000000-0000-4000-8000-00000000000${index}`;
const wait = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const seed = (db: D1Database, user: string, index: number): Promise<unknown> =>
  db.batch([
    db
      .prepare(
        "INSERT INTO users(id,time_zone,service_market,locale,created_at_ms) VALUES(?,'America/Bogota','CO','es-CO',1)"
      )
      .bind(user),
    db
      .prepare(`INSERT INTO card_enrollments(id,user_id,price_id,billing_email,status,payment_source_mode,
    contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,payment_request_id,wompi_candidate_source_id,method,wompi_environment)
    VALUES(?,?,'22700000-0000-4000-8000-000000000001','qa@example.test','creating','create','{}','{}',0,900000,?,?,'card','sandbox')`)
      .bind(id(2, index), user, id(5, index), 40 + index),
    db
      .prepare(
        "UPDATE card_enrollments SET payment_source_id=incoming.id,source_wompi_id=incoming.wompi_source_id,source_billing_email=incoming.billing_email,source_created_at_ms=incoming.created_at_ms,source_method=incoming.method FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?,?,?,?,'qa@example.test',0,'card'))) incoming WHERE card_enrollments.id=incoming.enrollment_id AND card_enrollments.user_id=incoming.user_id"
      )
      .bind(id(3, index), user, id(2, index), 40 + index),
    db.prepare("UPDATE card_enrollments SET status='available' WHERE id=?").bind(id(2, index)),
    db
      .prepare(`INSERT INTO billing_attempts(id,user_id,enrollment_id,payment_request_id,payment_source_id,price_id,amount,currency,billing_period,service_market,tax_treatment,time_zone,wompi_environment,wompi_reference,created_at_ms)
    VALUES(?,?,?,?,?,'22700000-0000-4000-8000-000000000001','9900','COP','weekly','CO','not-taxable','America/Bogota','sandbox',?,0)`)
      .bind(id(4, index), user, id(2, index), id(5, index), id(3, index), `fidy-${index}`),
    db
      .prepare(
        "UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=1 WHERE id=?"
      )
      .bind(id(4, index)),
    db
      .prepare("INSERT INTO billing_provider_transactions(transaction_id,attempt_id) VALUES(?,?)")
      .bind(`declined-${index}`, id(4, index)),
    db
      .prepare("UPDATE billing_attempts SET checkout_transaction_id=?2 WHERE id=?1")
      .bind(id(4, index), `declined-${index}`),
    db
      .prepare(
        "UPDATE billing_provider_transactions SET status='DECLINED',first_observed_at_ms=1,negative_observed_at_ms=1,finalized_at_ms=1 WHERE transaction_id=?1 AND attempt_id=?2"
      )
      .bind(`declined-${index}`, id(4, index)),
    db
      .prepare("UPDATE billing_attempts SET status='failed',finalized_at_ms=181001 WHERE id=?")
      .bind(id(4, index)),
  ]);

it("preserves billing erasure guards and disposes only the reviewed User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* wait(() => databases.acquire());
      yield* wait(() => installTestSchema({ db }));
      yield* wait(() => seed(db, userId, 1));
      yield* wait(() => seed(db, foreignUser, 2));
      yield* wait(() =>
        db
          .prepare("UPDATE card_enrollments SET source_retired_at_ms=200000 WHERE user_id=?")
          .bind(userId)
          .run()
      );
      yield* wait(() =>
        db.batch([
          db
            .prepare(`INSERT INTO card_enrollments(id,user_id,price_id,billing_email,status,payment_source_mode,contracts_json,disclosure_json,prepared_at_ms,expires_at_ms,wompi_candidate_source_id,method,wompi_environment)
      VALUES(?,?,'22700000-0000-4000-8000-000000000001','qa@example.test','creating','create','{}','{}',0,900000,43,'card','sandbox')`)
            .bind(id(2, 3), userId),
          db
            .prepare(
              "UPDATE card_enrollments SET payment_source_id=incoming.id,source_wompi_id=incoming.wompi_source_id,source_billing_email=incoming.billing_email,source_created_at_ms=incoming.created_at_ms,source_method=incoming.method FROM (SELECT column1 AS id,column2 AS user_id,column3 AS enrollment_id,column4 AS wompi_source_id,column5 AS billing_email,column6 AS created_at_ms,column7 AS method FROM (VALUES (?,?,?,43,'qa@example.test',0,'card'))) incoming WHERE card_enrollments.id=incoming.enrollment_id AND card_enrollments.user_id=incoming.user_id"
            )
            .bind(id(3, 3), userId, id(2, 3)),
        ])
      );
      const current = yield* Clock.currentTimeMillis;
      const decision = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        dispositions: { billing: { action: "Retain", retention: { untilMs: current + 86400000 } } },
      });
      yield* wait(() =>
        db
          .prepare(
            "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,'Sealing',?)"
          )
          .bind(reference, userId, decision)
          .run()
      );
      for (const sql of [
        "UPDATE card_enrollments SET source_row_ref=NULL,payment_source_id=NULL,source_wompi_id=NULL,source_billing_email=NULL,source_created_at_ms=NULL,source_retired_at_ms=NULL,source_method=NULL WHERE payment_source_id IS NOT NULL AND user_id=?",
        "UPDATE card_enrollments SET source_retired_at_ms=1 WHERE user_id=?",
        "UPDATE billing_attempts AS billing_checkout_responses SET checkout_transaction_id=NULL WHERE checkout_transaction_id IS NOT NULL AND id IN(SELECT id FROM billing_attempts WHERE user_id=?)",
        "UPDATE billing_attempts SET checkout_transaction_id=checkout_transaction_id||'x' WHERE user_id=?",
      ]) {
        yield* wait(() =>
          expect(db.prepare(sql).bind(userId).run()).rejects.toThrow(
            /erasure_fenced|card_source_immutable|billing_checkout_response_immutable/
          )
        );
      }
      yield* wait(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO erasure_requests(id,user_id,requested_at_ms,state,decision_json) VALUES(?,?,1,'Erasing',?)"
            )
            .bind(foreignReference, foreignUser, decision),
          db
            .prepare("INSERT INTO erasure_permits VALUES(?,?,'billing_checkout_responses')")
            .bind(foreignReference, foreignUser),
        ])
      );
      yield* wait(() =>
        expect(
          db
            .prepare(
              "UPDATE billing_attempts AS billing_checkout_responses SET checkout_transaction_id=NULL WHERE checkout_transaction_id IS NOT NULL AND id=?"
            )
            .bind(id(4, 1))
            .run()
        ).rejects.toThrow()
      );
      yield* wait(() =>
        db.prepare("DELETE FROM erasure_permits WHERE request_id=?").bind(foreignReference).run()
      );
      yield* wait(() =>
        db.prepare("UPDATE erasure_requests SET state='Draining' WHERE id=?").bind(reference).run()
      );
      yield* wait(() =>
        db
          .prepare(
            "UPDATE card_enrollments SET source_row_ref=NULL,payment_source_id=NULL,source_wompi_id=NULL,source_billing_email=NULL,source_created_at_ms=NULL,source_retired_at_ms=NULL,source_method=NULL WHERE payment_source_id=?"
          )
          .bind(id(3, 3))
          .run()
      );
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT count(*) FROM erasure_archives WHERE request_id=? AND store_id='card_payment_sources' AND json_type(body,'$.retired_at_ms')='null'"
            )
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(1);
      yield* wait(() =>
        db.prepare("UPDATE erasure_requests SET state='Archiving' WHERE id=?").bind(reference).run()
      );
      const stores = makeSubscriptionErasureStores(db);
      for (const store of stores) {
        yield* wait(() =>
          db
            .prepare(
              "INSERT INTO erasure_steps(request_id,store_id,data_class) VALUES(?,?,'billing')"
            )
            .bind(reference, store.id)
            .run()
        );
        expect(yield* store.archive({ userId, reference })).toBe(true);
      }
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT json_extract(body,'$.retired_at_ms') FROM erasure_archives WHERE request_id=? AND store_id='card_payment_sources' AND json_extract(body,'$.id')=?"
            )
            .bind(reference, id(3, 1))
            .first("json_extract(body,'$.retired_at_ms')")
        )
      ).toBe(200000);
      expect(
        yield* wait(() =>
          db
            .prepare(
              "SELECT count(*) FROM erasure_archives WHERE request_id=? AND store_id='billing_checkout_responses'"
            )
            .bind(reference)
            .first("count(*)")
        )
      ).toBe(1);
      yield* wait(() =>
        db.prepare("UPDATE erasure_requests SET state='Erasing' WHERE id=?").bind(reference).run()
      );
      const removal = [
        "billing_checkout_responses",
        "billing_provider_transactions",
        "billing_history",
        "card_payment_sources",
        "card_enrollments",
      ];
      for (const name of removal) {
        const store = stores.find((candidate) => candidate.id === name);
        if (store === undefined) throw new Error(`Missing ${name}`);
        expect(yield* store.remove({ userId, reference })).toBe(true);
      }
      expect(
        yield* wait(() =>
          db
            .prepare("SELECT count(*) FROM billing_attempts WHERE user_id=?")
            .bind(userId)
            .first("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(() =>
          db
            .prepare("SELECT count(*) FROM billing_attempts WHERE user_id=?")
            .bind(foreignUser)
            .first("count(*)")
        )
      ).toBe(1);
      expect(
        yield* wait(() =>
          db
            .prepare("SELECT count(*) FROM verified_payment_sources WHERE user_id=?")
            .bind(userId)
            .first("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(() => db.prepare("SELECT count(*) FROM erasure_permits").first("count(*)"))
      ).toBe(0);
      expect((yield* wait(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
  ));
