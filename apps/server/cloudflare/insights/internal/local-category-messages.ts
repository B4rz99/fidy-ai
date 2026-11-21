import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Schema } from "effect";
import { ConsentSubject } from "./consent-subject";
import { Hex } from "effect/encoding";
import {
  PreparedProactivityTemplate,
  type ProactivityTemplateSender,
} from "../../../src/shell/channels/whatsapp/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { digestBytes, newId } from "../../secret-material/operations";

import { withStoreAdmission } from "../../runtime/sqlite/operations";

const rows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    grant_id: Schema.String,
    user_id: Schema.String,
    deadline_ms: Schema.Int,
    parameter: Schema.String,
    portfolio: Schema.String,
    bsuid: Schema.String,
    endpoint: Schema.String,
  })
);

const queueAlert = Effect.fnUntraced(function* (
  item: (typeof rows.Type)[number],
  sender: ProactivityTemplateSender,
  now: number
) {
  const sql = yield* SqliteClient;

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedProactivityTemplate))(
    yield* sender.prepare(item.parameter)
  );

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(body);
  const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(encoded)));
  yield* sql`INSERT INTO reminder_deliveries(id,user_id,grant_id,correlation,portfolio,bsuid,endpoint,deadline_ms,offer_ms,body,digest,created_ms) VALUES(${item.id},${item.user_id},${item.grant_id},${newId()},${item.portfolio},${item.bsuid},${item.endpoint},${item.deadline_ms},${now},${body},${digest},${now})`;
  yield* sql`DELETE FROM category_alert_groups WHERE id=${item.id}`;
});

const queueAlerts = (
  selected: typeof rows.Type,
  sender: ProactivityTemplateSender,
  now: number
): Effect.Effect<void, Effect.Error<ReturnType<typeof queueAlert>>, SqliteClient> =>
  Effect.forEach(selected, (item) => queueAlert(item, sender, now), { discard: true });

export const publishCategoryMessages = Effect.fn(function* (
  now: number,
  sender: ProactivityTemplateSender
) {
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const sql = yield* SqliteClient;
      yield* sql`DELETE FROM category_alert_groups WHERE id IN(SELECT q.id FROM category_alert_groups q JOIN proactive_grants g ON g.id=q.grant_id WHERE g.revoked_at_ms IS NOT NULL OR q.deadline_ms<=${now} ORDER BY q.due_ms LIMIT 16)`;

      const live = protectConsentStatement({
        subject: ConsentSubject.Owner({ column: "u.id" }),
        requirement: "active",
        statement: {
          sql: "SELECT g.id FROM proactive_grants g JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=g.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE g.id=q.grant_id AND g.revoked_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
          params: [],
        },
      });

      yield* sql.unsafe(
        `DELETE FROM category_alert_groups WHERE id IN(SELECT q.id FROM category_alert_groups q WHERE q.due_ms<=? AND NOT EXISTS(${live.sql}) ORDER BY q.due_ms LIMIT 16)`,
        [now, ...live.params]
      );

      const guard = protectConsentStatement({
        subject: ConsentSubject.Owner({ column: "u.id" }),
        requirement: "active",
        statement: {
          sql: "SELECT q.*,g.user_id,c.portfolio,c.bsuid,c.endpoint FROM category_alert_groups q JOIN insight_events e ON e.id=q.id JOIN proactive_grants g ON g.id=q.grant_id AND g.user_id=e.user_id AND g.kind=json_extract(e.event_json,'$.kind') AND g.revoked_at_ms IS NULL JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=g.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE q.due_ms<=? AND q.deadline_ms>? AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
          params: [now, now],
        },
      });

      const selected = yield* Schema.decodeUnknownEffect(rows)(
        yield* sql.unsafe(guard.sql + " ORDER BY q.due_ms,q.id LIMIT 16", guard.params)
      );

      if (selected.length > 0) yield* admitGrowth;

      yield* queueAlerts(selected, sender, now);
    })
  );
});
