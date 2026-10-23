import { Effect, Schema } from "effect";
import { expect, it } from "vitest";

import { queuedWhatsAppTurn, setup, users } from "../agent/hosted-turn.test-fixture";
import {
  CutoverHistory,
  documentedSqlBlock,
  makeSchemaCutover,
  precedingSchema,
  schemaStatements,
} from "../schema-cutover.test-fixture";

const tables = ["whatsapp_event_records", "whatsapp_deliveries"];
const { scratch, swap } = makeSchemaCutover(tables);
it.each(["valid", "grant-collision", "unexpected-grant", "retry-history", "count", "interruption"])(
  "preserves delivery grants, outcomes and callback replay evidence through cutover and inverse: %s",
  (historyCase) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const turn = yield* Effect.tryPromise(() =>
          queuedWhatsAppTurn({ db, index: 0, text: "original activity" })
        );
        const current = schemaStatements(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("../migrations/0001_schema.sql", import.meta.url)).text()
          )
        );
        const history = yield* Schema.decodeEffect(CutoverHistory)(
          yield* Effect.tryPromise(() =>
            Bun.file(new URL("./delivery-cutover.test-fixture.json", import.meta.url)).text()
          )
        );
        const previous = precedingSchema({ current, history });
        const guide = yield* Effect.tryPromise(() =>
          Bun.file(
            new URL("../../../../docs/operations/database-cutover-1428.md", import.meta.url)
          ).text()
        );
        const block = (part: string): ReadonlyArray<D1PreparedStatement> =>
          documentedSqlBlock({ guide, marker: "whatsapp-delivery-" + part }).map((sql) =>
            db.prepare(sql)
          );
        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard"),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
            ...block("verify"),
            db
              .prepare(
                "INSERT INTO consent_offers(id,user_id,portfolio_id,bsuid,disclosure_json,created_at_ms,expires_at_ms) VALUES('original-offer',?,'portfolio-1','recipient','{}',17,86400017)"
              )
              .bind(users[0]),
            db
              .prepare(
                "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at_ms,money_groups_json) VALUES('original-event',?,'weekly-summary','original-schedule',1,'CO','es-CO','UTC',17,'[]')"
              )
              .bind(users[0]),
            db
              .prepare(
                "INSERT INTO whatsapp_deliveries(rowid,kind,user_id,id,offer_id,grant_id,created_at_ms,expires_at_ms,correlation_token,portfolio_id,bsuid,business_phone_number_id,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) VALUES(17,'weekly-question',?,'original-question','original-offer','original-weekly-grant',17,86400017,'question-correlation','portfolio-1','recipient','phone','UTC','ambiguous',19,NULL,NULL)"
              )
              .bind(users[0]),
            db
              .prepare(
                "INSERT INTO whatsapp_deliveries(rowid,kind,user_id,delivery_id,role,consent_grant_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state,send_started_at_ms,provider_message_id,delivered_at_ms) VALUES(83,'proactivity',?,'original-delivery','manual-entry-reminder','original-reminder-grant','proactive-correlation','portfolio-1','recipient','phone',17,86400017,'UTC','delivered',19,'provider-proactive',23)"
              )
              .bind(users[0]),
            db
              .prepare(
                "INSERT INTO whatsapp_deliveries(rowid,kind,user_id,insight_event_id,correlation_token,portfolio_id,bsuid,business_phone_number_id,scheduled_at_ms,expires_at_ms,time_zone,state) VALUES(91,'insight',?,'original-event','insight-correlation','portfolio-1','recipient','phone',17,86400017,'UTC','staged')"
              )
              .bind(users[0]),
            db
              .prepare(
                "INSERT INTO whatsapp_deliveries(rowid,kind,user_id,turn_id,text,correlation_token,business_phone_number_id,proposed_at_ms,state) VALUES(103,'hosted',?,?,'original reply','hosted-correlation','phone',17,'ambiguous')"
              )
              .bind(users[0], turn),
            db.prepare(
              "INSERT INTO whatsapp_event_records(rowid,kind,correlation_token,provider_message_id,status,occurred_at_ms,received_at_ms) VALUES(211,'delivery-status','hosted-correlation','provider-hosted','sent',19,23)"
            ),
          ])
        );
        if (historyCase === "grant-collision") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE whatsapp_deliveries SET consent_grant_id='different-evidence' WHERE rowid=17"
              )
              .run()
          );
        }
        if (historyCase === "unexpected-grant") {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "UPDATE whatsapp_deliveries SET grant_id='unexpected-evidence' WHERE rowid=91"
              )
              .run()
          );
        }
        if (historyCase === "retry-history") {
          yield* Effect.tryPromise(() =>
            db.prepare("UPDATE whatsapp_deliveries SET last_attempt_at_ms=29 WHERE rowid=17").run()
          );
        }
        const read = (table: string): Promise<D1Result> =>
          db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all();
        const original = yield* Effect.tryPromise(() => read("whatsapp_deliveries"));
        const callbacks = yield* Effect.tryPromise(() => read("whatsapp_event_records"));
        const result = yield* Effect.result(
          Effect.tryPromise(() =>
            db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...documentedSqlBlock({ guide, marker: "whatsapp-delivery-guard" }).map((sql) =>
                db.prepare(sql).bind(historyCase === "count" ? 5 : 4)
              ),
              ...scratch(current, tables).map((sql) => db.prepare(sql)),
              ...block("copy"),
              ...swap({
                db,
                source: previous,
                target: current,
                sourceNames: tables,
                targetNames: tables,
              }),
              ...(historyCase === "interruption"
                ? [db.prepare("INSERT INTO sql_assertions VALUES('interrupt_delivery',0)")]
                : []),
              ...block("verify"),
            ])
          )
        );
        if (historyCase !== "valid") {
          expect(result._tag).toBe("Failure");
          expect((yield* Effect.tryPromise(() => read("whatsapp_deliveries"))).results).toEqual(
            original.results
          );
          expect((yield* Effect.tryPromise(() => read("whatsapp_event_records"))).results).toEqual(
            callbacks.results
          );
          return;
        }
        expect(result._tag).toBe("Success");
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT consent_grant_id,state,send_started_at_ms FROM whatsapp_deliveries WHERE rowid=17"
              )
              .first()
          )
        ).toEqual({
          consent_grant_id: "original-weekly-grant",
          state: "ambiguous",
          send_started_at_ms: 19,
        });
        expect((yield* Effect.tryPromise(() => read("whatsapp_event_records"))).results).toEqual(
          callbacks.results
        );

        yield* Effect.tryPromise(() =>
          db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...block("rollback-guard"),
            ...scratch(previous, tables).map((sql) => db.prepare(sql)),
            ...block("rollback-copy"),
            ...swap({
              db,
              source: current,
              target: previous,
              sourceNames: tables,
              targetNames: tables,
            }),
            ...block("verify"),
          ])
        );
        expect((yield* Effect.tryPromise(() => read("whatsapp_deliveries"))).results).toEqual(
          original.results
        );
        expect((yield* Effect.tryPromise(() => read("whatsapp_event_records"))).results).toEqual(
          callbacks.results
        );
      })
    )
);
