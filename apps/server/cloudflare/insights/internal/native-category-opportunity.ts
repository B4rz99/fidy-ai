import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { ConsentSubject } from "./consent-subject";
import { disclosureWindowAt } from "./category-window";
import {
  UserId,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../../src/core/identity/contract";
import type { ProactivityTemplateSender } from "../../../src/shell/channels/whatsapp/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import type { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import { available, enqueueDisclosure } from "./local-reminder-choice";

const offerLifetime = 600000;

export const discoverCategoryOpportunity = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  if (!(yield* available(event, false, now))) return;
  yield* sql`INSERT INTO insight_contacts VALUES(${event.userId},${event.portfolioId},${event.bsuid},${event.businessPhoneNumberId},${event.occurredAtMs}) ON CONFLICT(user_id) DO UPDATE SET portfolio=excluded.portfolio,bsuid=excluded.bsuid,endpoint=excluded.endpoint,observed_ms=excluded.observed_ms WHERE excluded.observed_ms>=insight_contacts.observed_ms`;
  yield* sql`UPDATE category_opportunities SET next_ms=${now} WHERE user_id=${event.userId} AND kind='budget-threshold' AND next_ms IS NULL AND offer_id IS NULL AND closed_ms IS NULL`;

  if (disclosureWindowAt(now) === now) {
    yield* sql`INSERT INTO category_opportunities(user_id,kind,source,next_ms) SELECT ${event.userId},'new-recurring-series',${event.messageId},${now} WHERE EXISTS(SELECT 1 FROM recurring_series WHERE user_id=${event.userId} AND confirmation_id IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM proactive_grants WHERE user_id=${event.userId} AND kind='new-recurring-series' AND revoked_at_ms IS NULL)
      ON CONFLICT(user_id,kind) DO UPDATE SET source=excluded.source,next_ms=excluded.next_ms,offer_id=NULL WHERE source<>excluded.source AND EXISTS(SELECT 1 FROM reminder_disclosures o LEFT JOIN whatsapp_deliveries w ON w.user_id=o.user_id AND w.operation_id=o.id AND w.family='disclosure' WHERE o.id=category_opportunities.offer_id AND ((o.expires_ms<=${now} AND w.started_ms IS NULL) OR w.state='rejected'))`;
  }

  const pending = yield* sql`SELECT 1 FROM category_opportunities WHERE next_ms<=${now} LIMIT 1`;

  if (pending.length > 0) yield* preserveStoreAlarm(storage, now);
});

const Due = Schema.Struct({
  user_id: UserId,
  kind: Schema.Literals(["budget-threshold", "new-recurring-series"]),
  source: Schema.String,
  portfolio: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  endpoint: WhatsAppBusinessPhoneNumberId,
});

const offerOpportunity = Effect.fn(function* (
  row: typeof Due.Type,
  {
    sender,
    storage,
    now,
    next,
  }: { sender: ProactivityTemplateSender; storage: DurableObjectStorage; now: number; next: number }
) {
  const sql = yield* SqliteClient;

  const [previous] =
    yield* sql`SELECT w.started_ms,o.expires_ms FROM category_opportunities q JOIN reminder_disclosures o ON o.id=q.offer_id LEFT JOIN whatsapp_deliveries w ON w.user_id=o.user_id AND w.operation_id=o.id AND w.family='disclosure' WHERE q.user_id=${row.user_id} AND q.kind=${row.kind}`;

  if (
    previous !== undefined &&
    (previous.started_ms !== null || row.kind === "new-recurring-series")
  ) {
    return;
  }

  if (next > now) {
    yield* sql`UPDATE category_opportunities SET next_ms=${next} WHERE user_id=${row.user_id} AND kind=${row.kind}`;
    yield* preserveStoreAlarm(storage, next);

    return;
  }

  const id = yield* enqueueDisclosure(
    {
      userId: row.user_id,
      portfolioId: row.portfolio,
      bsuid: row.bsuid,
      businessPhoneNumberId: row.endpoint,
      occurredAtMs: now,
      messageId: row.kind + ":" + newId(),
    },
    { kind: row.kind, senders: { category: Option.some(sender), weekly: Option.none() }, now }
  );

  const retry = now + offerLifetime;
  yield* sql`UPDATE category_opportunities SET offer_id=coalesce(${Option.getOrNull(id)},offer_id),next_ms=${retry} WHERE user_id=${row.user_id} AND kind=${row.kind}`;
  yield* preserveStoreAlarm(storage, now);
});

export const materializeCategoryOpportunity = Effect.fn(function* (
  sender: ProactivityTemplateSender,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  yield* sql`UPDATE category_opportunities AS q SET closed_ms=${now},next_ms=NULL WHERE q.closed_ms IS NULL AND q.kind='budget-threshold' AND EXISTS(SELECT 1 FROM proactive_grants g WHERE g.user_id=q.user_id AND g.kind=q.kind AND g.revoked_at_ms IS NULL)`;

  const guarded = protectConsentStatement({
    subject: ConsentSubject.Owner({ column: "u.id" }),
    requirement: "active",
    statement: {
      sql: "SELECT q.user_id,q.kind,q.source,c.portfolio,c.bsuid,c.endpoint FROM category_opportunities q JOIN insight_contacts c ON c.user_id=q.user_id JOIN users u ON u.id=q.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE q.next_ms<=? AND q.closed_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests) AND NOT EXISTS(SELECT 1 FROM proactive_grants g WHERE g.user_id=u.id AND g.kind=q.kind AND g.revoked_at_ms IS NULL) ",
      params: [now],
    },
  });

  const due = yield* Schema.decodeUnknownEffect(Schema.Array(Due))(
    yield* sql.unsafe(guarded.sql + " ORDER BY q.next_ms,q.kind LIMIT 2", guarded.params)
  );

  yield* sql`UPDATE category_opportunities SET next_ms=NULL WHERE next_ms<=${now}`;
  const next = disclosureWindowAt(now);

  yield* Effect.forEach(due, (row) => offerOpportunity(row, { sender, storage, now, next }), {
    discard: true,
  });
});
