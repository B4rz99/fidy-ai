import { activateWeekly, weeklyQuestion } from "./native-weekly";
import { activateDigest } from "./native-recurring-digest";
import { ProactivityOptInKind } from "../../../src/shell/consent/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { ConsentSubject } from "./consent-subject";
import { Hex } from "effect/encoding";
import {
  type ConsentDecisionEvidence,
  type ConsentEvent,
  type ConsentGrant,
  ConsentRecord,
  ConsentRecordId,
  DisclosureSnapshot,
} from "../../../src/core/consent/contract";
import { ReminderSchedule } from "../../../src/core/insights/contract";
import { nextReminderOccurrence } from "../../../src/core/insights/operations";
import {
  proactivityDisclosureFor,
  protectConsentStatement,
  weeklyDisclosureFor,
} from "../../../src/shell/consent/operations";
import {
  PreparedProactivityTemplate,
  type ProactivityTemplateSender,
  type WeeklyQuestionSender,
} from "../../../src/shell/channels/whatsapp/contract";
import { WhatsAppProviderMessageId } from "../../../src/core/provider-evidence/contract";
import type { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import { digestBytes, newId } from "../../secret-material/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";

const life = 600000,
  day = 86400000,
  drift = 300000,
  precision = 1000;

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const refused = (): Response => new Response(null, { status: 422 }),
  success = (): Response => new Response(null, { status: 200 });

export const available = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  privacy: boolean,
  now: number
) {
  if (
    event.occurredAtMs + day <= now ||
    event.occurredAtMs > Math.min(now, event.receivedAtMs) + drift
  ) {
    return false;
  }

  const sql = yield* SqliteClient,
    association = {
      sql: "SELECT id FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND whatsapp_verified_at_ms<=? AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)",
      params: [
        event.userId,
        event.portfolioId,
        event.bsuid,
        event.occurredAtMs + precision - 1,
        event.userId,
      ],
    };

  const guard = privacy
    ? association
    : protectConsentStatement({
        subject: ConsentSubject.User({ userId: event.userId }),
        requirement: "active",
        statement: association,
      });

  return (yield* sql.unsafe(guard.sql, guard.params)).length === 1;
});

const OfferKind = Schema.Union([ProactivityOptInKind, Schema.Literal("weekly-summary")]);

type OfferKind = typeof OfferKind.Type;

type ChoiceSenders = {
  category: Option.Option<ProactivityTemplateSender>;
  weekly: Option.Option<WeeklyQuestionSender>;
};

const commands = new Map<string, OfferKind>([
  ["resumen semanal", "weekly-summary"],
  ["recordatorios", "manual-entry-reminder"],
  ["alertas de presupuesto", "budget-threshold"],
  ["avisos de cargos recurrentes", "new-recurring-series"],
]);

const requestedKind = (text: string): Option.Option<OfferKind> =>
  Option.fromUndefinedOr(
    commands.get(/^(?:re)?activar (?:(?:los|el) )?(.+)$/u.exec(text)?.[1] ?? "")
  );

const qualifiedChoice =
  /^p:(manual-entry-reminder|budget-threshold|new-recurring-series):([0-9a-f-]{36}):(accept|decline|revoke)$/u;

export const activeChoiceText = (input: string): boolean => {
  const text = input.trim().toLowerCase();

  return (
    Option.isSome(requestedKind(text)) ||
    qualifiedChoice.test(text) ||
    /^weekly:[0-9a-f-]{36}:(?:accept|decline|revoke)$/u.test(text) ||
    /^(?:s[ií]|no|desactivar)$/u.test(text)
  );
};

type DisclosureAddress = Pick<
  WhatsAppTurnAdmission,
  "userId" | "portfolioId" | "bsuid" | "businessPhoneNumberId" | "occurredAtMs"
> & { messageId: string };

export const enqueueDisclosure = Effect.fn(function* (
  event: DisclosureAddress,
  { senders, kind, now }: { senders: ChoiceSenders; kind: OfferKind; now: number }
) {
  const sql = yield* SqliteClient;

  const [grant] =
    yield* sql`SELECT id FROM proactive_grants WHERE user_id=${event.userId} AND kind=${kind} AND revoked_at_ms IS NULL`;

  const grantId = grant?.id;

  const disclosure =
    kind === "weekly-summary" ? weeklyDisclosureFor() : proactivityDisclosureFor(kind);

  const instructions =
    grant === undefined
      ? " Responde a este mensaje con «Sí» para activar estos avisos o «No» para rechazarlos."
      : " Responde a este mensaje con «Sí» para continuar o «Desactivar» para dejar de recibirlos.";

  const id = newId();

  const body =
    kind === "weekly-summary"
      ? yield* weeklyQuestion(yield* Effect.fromOption(senders.weekly), id, grant !== undefined)
      : yield* (yield* Effect.fromOption(senders.category))
          .prepare(disclosure.text + instructions)
          .pipe(
            Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(PreparedProactivityTemplate)))
          );

  const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(yield* json(body))));

  const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    disclosure
  );

  const expires = event.occurredAtMs + life;

  if (expires <= now) return Option.none<string>();

  const inserted =
    yield* sql`INSERT INTO reminder_disclosures(id,user_id,portfolio,bsuid,endpoint,request_message,created_ms,expires_ms,attempt_ms,correlation,disclosure,body,digest,grant_id,kind)
    SELECT ${id},${event.userId},${event.portfolioId},${event.bsuid},${event.businessPhoneNumberId},${event.messageId},${event.occurredAtMs},${expires},${now},${newId()},${serialized},${body},${digest},${Predicate.isString(grantId) ? grantId : null},${kind}
    WHERE (SELECT count(*) FROM reminder_disclosures WHERE user_id=${event.userId} AND created_ms>${now - day})<8 AND NOT EXISTS(SELECT 1 FROM reminder_disclosures o WHERE o.user_id=${event.userId} AND o.kind=${kind} AND o.expires_ms>${now} AND NOT EXISTS(SELECT 1 FROM reminder_choices c WHERE c.offer_id=o.id)) ON CONFLICT DO NOTHING RETURNING id`;

  return inserted.length === 1 ? Option.some(id) : Option.none<string>();
});

const offer = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  {
    senders,
    kind,
    storage,
  }: {
    senders: ChoiceSenders;
    kind: OfferKind;
    storage: DurableObjectStorage;
  }
) {
  const now = yield* Clock.currentTimeMillis;

  if (!(yield* available(event, false, now))) return refused();
  yield* enqueueDisclosure(event, { senders, kind, now });
  yield* preserveStoreAlarm(storage, now);

  return new Response(null, { status: 202 });
});

const activation = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  { grant, kind, now }: { grant: string; kind: OfferKind; now: number }
) {
  if (kind === "weekly-summary") return yield* activateWeekly(event.userId, grant, now);

  if (kind === "new-recurring-series") return yield* activateDigest(event.userId, grant, now);

  if (kind !== "manual-entry-reminder") return now;
  const sql = yield* SqliteClient;

  const [old] =
    yield* sql`SELECT snapshot_json FROM reminder_schedules WHERE user_id=${event.userId}`;

  const codec = Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule));

  const oldSchedule = Option.flatMap(
    Option.fromUndefinedOr(old?.snapshot_json),
    Schema.decodeUnknownOption(codec)
  );

  const instructions = Option.match(oldSchedule, {
    onNone: () => ({
      id: newId(),
      version: 1,
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: IanaTimeZone.make("America/Bogota"),
      cadence: { kind: "daily" as const },
      timing: { hour: 18, minute: 0 },
    }),
    onSome: (prior) => ({ ...prior, version: prior.version + 1 }),
  });

  const schedule = yield* Schema.decodeUnknownEffect(Schema.toType(ReminderSchedule))({
    ...instructions,
    enabled: true,
    nextScheduledAt: nextReminderOccurrence({ ...instructions, after: DateTime.makeUnsafe(now) }),
  });

  const saved = yield* Schema.encodeEffect(codec)(schedule);
  yield* sql`INSERT INTO reminder_schedules(user_id,id,revision,snapshot_json,next_at_ms,grant_id) VALUES(${event.userId},${schedule.id},${schedule.version},${saved},${schedule.nextScheduledAt.epochMilliseconds},${grant}) ON CONFLICT(user_id) DO UPDATE SET grant_id=excluded.grant_id,revision=excluded.revision,snapshot_json=excluded.snapshot_json,next_at_ms=excluded.next_at_ms,retry_at_ms=0`;
  yield* sql`INSERT INTO reminder_revisions VALUES(${schedule.id},${schedule.version},${saved})`;

  return schedule.nextScheduledAt.epochMilliseconds;
});

type Decision = "accept" | "decline" | "revoke";

const decisionFor = (text: string): Option.Option<Decision> => {
  if (["sí", "si", "accept"].includes(text)) return Option.some("accept");

  if (["no", "decline"].includes(text)) return Option.some("decline");

  return ["desactivar", "revoke"].includes(text) ? Option.some("revoke") : Option.none();
};

const disclosureRow = Schema.Struct({
  id: Schema.String,
  kind: OfferKind,
  expires_ms: Schema.Int,
  disclosure: Schema.fromJsonString(DisclosureSnapshot),
  provider_message_id: WhatsAppProviderMessageId,
  grant_id: Schema.OptionFromNullOr(ConsentRecordId),
  live_id: Schema.OptionFromNullOr(ConsentRecordId),
});

type Proof = typeof disclosureRow.Type;

const replayChoice = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  input: { choice: Decision; offer: string }
) {
  const sql = yield* SqliteClient;

  const [prior] =
    yield* sql`SELECT choice,offer_id FROM reminder_choices WHERE user_id=${event.userId} AND message=${event.messageId}`;

  return Option.map(Option.fromUndefinedOr(prior), (row) =>
    row.choice === input.choice && row.offer_id === input.offer ? success() : refused()
  );
});

const decide = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  held: Proof,
  { choice, storage }: { choice: Decision; storage: DurableObjectStorage }
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const replay = yield* replayChoice(event, { choice, offer: held.id });

  if (Option.isSome(replay)) return replay.value;

  if (!(yield* available(event, choice !== "accept", now))) return refused();

  if (choice === "accept" && held.expires_ms <= now) return refused();

  const [prior] =
    yield* sql`SELECT choice FROM reminder_choices WHERE offer_id=${held.id} AND choice<>'revoke'`;

  if (prior !== undefined && choice !== "revoke") return refused();

  return yield* retainDecision(event, held, { choice, storage, now });
});

const ConsentEventOf = Data.taggedEnum<ConsentEvent>();

const ConsentGrantOf = Data.taggedEnum<ConsentGrant>();

const ConsentEvidenceOf = Data.taggedEnum<ConsentDecisionEvidence>();

const legalDecision = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  held: Proof,
  { choice, now }: { choice: Decision; now: number }
) {
  const id = ConsentRecordId.make(newId()),
    revocation = choice === "accept" ? Option.none<ConsentRecordId>() : held.live_id,
    revoke = Option.isSome(revocation);

  const record = ConsentRecord.make({
    id,
    subjectUserId: event.userId,
    occurredAt: DateTime.makeUnsafe(now),
    disclosure: held.disclosure,
    event: Option.match(revocation, {
      onNone: () =>
        ConsentEventOf.Granted({
          grant: ConsentGrantOf.InsightDelivery({ insightKind: held.kind }),
        }),
      onSome: (grantId) => ConsentEventOf.Revoked({ grantId }),
    }),
    evidence: ConsentEvidenceOf.ProviderQualifiedMessages({
      disclosureMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: held.provider_message_id,
      },
      decisionMessage: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: event.messageId,
      },
    }),
  });

  const jsonRecord = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(ConsentRecord))
  )(record);

  return {
    id,
    jsonRecord,
    revocation,
    revoke,
    newGrant: choice === "accept" && Option.isNone(held.live_id),
  };
});

const resetAttention = Effect.fn(function* (held: Proof, now: number) {
  const sql = yield* SqliteClient;

  if (held.kind === "weekly-summary") {
    yield* sql`UPDATE weekly_attention SET unanswered=0,last_reply_ms=${now},ask_ms=NULL,question_id=NULL,question_delivered_ms=NULL,paused_ms=NULL,notice_turn=NULL,notice_delivered=0 WHERE grant_id=${Option.getOrNull(held.grant_id)} AND grant_id=${Option.getOrNull(held.live_id)}`;
  }

  yield* sql`UPDATE reminder_attention SET unanswered=0,last_reply_ms=${now},question_id=NULL,question_delivered_ms=NULL,notice_turn=NULL,notice_delivered=0 WHERE grant_id=${Option.getOrNull(held.live_id)} AND grant_id=${Option.getOrNull(held.grant_id)}`;
});

const retainDecision = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  held: Proof,
  action: { choice: Decision; storage: DurableObjectStorage; now: number }
) {
  const sql = yield* SqliteClient;
  const { choice, now } = action;

  const { id, jsonRecord, revocation, revoke, newGrant } = yield* legalDecision(event, held, {
    choice,
    now,
  });

  if (Option.isSome(revocation)) {
    const changed =
      yield* sql`UPDATE proactive_grants SET revoked_at_ms=${now} WHERE id=${revocation.value} AND user_id=${event.userId} AND revoked_at_ms IS NULL AND (id=${Option.getOrNull(held.grant_id)} OR json_extract(record_json,'$.evidence.disclosureMessage.providerMessageId')=${held.provider_message_id}) RETURNING id`;

    if (changed.length !== 1) return refused();
  } else if (newGrant) {
    if (Option.isSome(held.grant_id)) return refused();
    yield* sql`INSERT INTO proactive_grants(user_id,kind,id,record_json) VALUES(${event.userId},${held.kind},${id},${jsonRecord})`;
    yield* sql`INSERT INTO reminder_channels VALUES(${id},${event.portfolioId},${event.bsuid},${event.businessPhoneNumberId})`;
    const wake = yield* activation(event, { grant: id, kind: held.kind, now });
    yield* preserveStoreAlarm(action.storage, wake);
  }

  if (choice === "accept") yield* resetAttention(held, now);
  yield* sql`INSERT INTO reminder_choices VALUES(${event.userId},${event.messageId},${held.id},${choice},${revoke || newGrant ? jsonRecord : null})`;

  return success();
});

const deliveredOffer = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  offerId: Option.Option<string>
) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT o.id,o.kind,o.expires_ms,o.disclosure,o.grant_id,g.id AS live_id,w.provider_message_id FROM reminder_disclosures o JOIN whatsapp_deliveries w ON w.user_id=o.user_id AND w.operation_id=o.id AND w.family='disclosure' AND w.correlation=o.correlation AND w.state='delivered' AND w.delivered_at_ms<=${event.occurredAtMs + precision - 1} LEFT JOIN proactive_grants g ON g.user_id=o.user_id AND g.kind=o.kind AND g.revoked_at_ms IS NULL WHERE o.user_id=${event.userId} AND o.portfolio=${event.portfolioId} AND o.bsuid=${event.bsuid} AND o.endpoint=${event.businessPhoneNumberId} AND ((${Option.getOrNull(offerId)} IS NULL AND w.provider_message_id=${Option.getOrNull(event.replyToMessageId)}) OR o.id=${Option.getOrNull(offerId)})`;

  return raw;
});

type ChoiceText = Readonly<{
  kind: Option.Option<string>;
  choice: Option.Option<Decision>;
  offer: Option.Option<string>;
}>;

const choiceFor = (text: string): ChoiceText => {
  const weekly = /^weekly:([0-9a-f-]{36}):(accept|decline|revoke)$/u.exec(text);

  if (weekly !== null) {
    return {
      kind: Option.some("weekly-summary"),
      choice: decisionFor(String(weekly[2])),
      offer: Option.fromUndefinedOr(weekly[1]),
    };
  }

  const parts = qualifiedChoice.exec(text);

  return {
    kind: Option.fromUndefinedOr(parts?.[1]),
    choice: decisionFor(parts === null ? text : String(parts[3])),
    offer: Option.fromUndefinedOr(parts?.[2]),
  };
};

const enabledFor = (kind: unknown, senders: ChoiceSenders): boolean =>
  kind === "weekly-summary" ? Option.isSome(senders.weekly) : Option.isSome(senders.category);

const resolveReply = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  {
    text,
    senders,
    storage,
  }: { text: string; senders: ChoiceSenders; storage: DurableObjectStorage }
) {
  const { kind, choice, offer } = choiceFor(text);

  if (Option.isNone(choice)) return Option.none<Response>();
  const raw = yield* deliveredOffer(event, offer);

  if (raw === undefined) {
    return Option.isNone(kind) ? Option.none<Response>() : Option.some(refused());
  }

  if (Option.isSome(kind) && kind.value !== raw.kind) return Option.some(refused());

  if (choice.value === "accept" && !enabledFor(raw.kind, senders)) {
    return Option.some(refused());
  }

  return Option.some(
    yield* decide(event, yield* Schema.decodeUnknownEffect(disclosureRow)(raw), {
      choice: choice.value,
      storage,
    })
  );
});

export const handleChoice = Effect.fn(function* (
  event: WhatsAppTurnAdmission,
  senders: ChoiceSenders,
  storage: DurableObjectStorage
) {
  const text = event.text.trim().toLowerCase();
  const kind = requestedKind(text);

  if (Option.isSome(kind)) {
    return Option.some(
      (
        kind.value === "weekly-summary"
          ? Option.isSome(senders.weekly)
          : Option.isSome(senders.category)
      )
        ? yield* offer(event, { senders, storage, kind: kind.value })
        : refused()
    );
  }

  return yield* resolveReply(event, { text, senders, storage });
});
