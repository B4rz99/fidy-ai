import { drainBootstrapExpiry } from "./expiry";
import { approveChannelPairing } from "./channel";
import { WhatsAppBootstrapText, localCallerUrl } from "../contract";
import { Clock, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

import { newId } from "../../secret-material/operations";
import { chargeBootstrapWindows } from "./admission";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { invalidProvider } from "../../browser-login/operations";

const isResponse = Schema.is(Schema.instanceOf(Response));

const maximumAccountLabelLength = 254;

const pairingLifetimeMs = 600000;

const noAction = (): Response => new Response(null, { status: 204 });

const conflict = (): Response => new Response(null, { status: 409 });

const reviewPattern = /^(?:Vincular|No vincular) (?:Google|Microsoft): .+ \[([0-9a-f-]{36})\]$/u;

const AccountLabel = Schema.Struct({
  provider: Schema.String,
  subject: Schema.String,
  contact_email: Schema.NullOr(Schema.String),
  phone: Schema.NullOr(Schema.String),
  review_code: Schema.NullOr(Schema.String),
  review_text: Schema.NullOr(Schema.String),
  review_attempt: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.String),
});

type ReviewMessage = Readonly<{
  existing: boolean;
  confirmationText: string;
  associationCode: string;
}>;

const reviewMessage = (
  row: typeof AccountLabel.Type,
  attempt: string,
  accountLabel: string
): ReviewMessage => {
  const reusable =
    row.review_attempt === attempt && row.review_code !== null && row.review_text !== null;

  const associationCode = reusable ? row.review_code : newId();

  const confirmationText = reusable
    ? row.review_text
    : `Vincular ${row.provider === "google" ? "Google" : "Microsoft"}: ${accountLabel} [${associationCode}]`;

  return { existing: reusable, confirmationText, associationCode };
};

export const invitationStatus = Effect.fn(function* (
  id: string,
  pairingId: string,
  attempt: string
) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;

  const [raw] =
    yield* sql`SELECT a.provider,a.subject,a.contact_email,i.phone,i.review_code,i.review_text,i.review_attempt,i.decision FROM whatsapp_invitations i JOIN provider_attempts a ON a.id=${attempt} AND a.invitation=i.id AND a.pairing_id=i.pairing_id WHERE i.id=${id} AND i.pairing_id=${pairingId} AND a.state='verified' AND i.expires_at_ms>${current}`;

  if (raw === undefined) return invalidProvider();
  const row = yield* Schema.decodeUnknownEffect(AccountLabel)(raw);

  if (row.review_attempt === attempt && row.decision !== null) {
    return Response.json(
      { status: row.decision === "confirmed" ? "verified" : "rejected" },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const accountLabel = (row.contact_email ?? row.subject)
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, maximumAccountLabelLength);

  const { existing, confirmationText, associationCode } = reviewMessage(row, attempt, accountLabel);

  if (!existing) {
    yield* sql`UPDATE whatsapp_invitations SET review_code=${associationCode},review_text=${confirmationText},review_started_ms=${current},review_attempt=${attempt} WHERE id=${id} AND decision IS NULL`;
  }

  return Response.json(
    {
      status: "awaiting_association",
      associationCode,
      confirmationText,
      accountLabel,
      whatsappPhone: row.phone,
    },
    { headers: { "cache-control": "no-store" } }
  );
});

const prepareInvitation = Effect.fn(function* (event: typeof WhatsAppBootstrapText.Type) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* drainBootstrapExpiry(now);

    const held =
      yield* sql`SELECT 1 FROM whatsapp_routes w JOIN erasure_barriers b ON b.user_id=w.user_id WHERE w.portfolio=${event.portfolio} AND w.bsuid=${event.bsuid}`;

    if (held.length !== 0) return noAction();

    const [duplicate] =
      yield* sql`SELECT send_rejected FROM whatsapp_invitations WHERE portfolio=${event.portfolio} AND message=${event.message}`;

    if (duplicate !== undefined) return duplicate.send_rejected === 1 ? conflict() : noAction();

    const [known] =
      yield* sql`SELECT user_id FROM whatsapp_routes WHERE portfolio=${event.portfolio} AND bsuid=${event.bsuid} AND established=1`;

    if (known !== undefined) return yield* Schema.decodeUnknownEffect(Schema.String)(known.user_id);

    const [existing] =
      yield* sql`SELECT id FROM whatsapp_invitations WHERE portfolio=${event.portfolio} AND bsuid=${event.bsuid} AND expires_at_ms>${now} LIMIT 1`;

    if (existing !== undefined) return noAction();

    const refusal = yield* chargeBootstrapWindows([
      { scope: "whatsapp-sends", limit: 1000, duration: 3600000 },
      {
        scope: "wa:" + event.portfolio.length + ":" + event.portfolio + event.bsuid,
        limit: 6,
        duration: 86400000,
      },
    ]);

    if (Option.isSome(refusal)) return refusal.value;
    const id = newId();
    yield* sql`INSERT INTO whatsapp_invitations(id,portfolio,bsuid,endpoint,message,phone,expires_at_ms) VALUES(${id},${event.portfolio},${event.bsuid},${event.endpoint},${event.message},${event.phone},${now + pairingLifetimeMs})`;

    return Response.json({ invitation: id });
  }).pipe(withStoreCapacity("growth"));
});

export const rejectInvitationSend = Effect.fn(function* (request: Request) {
  const { id, message } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String, message: Schema.String })
  )(yield* Effect.tryPromise(() => request.json()));

  const now = yield* Clock.currentTimeMillis,
    sql = yield* SqliteClient;

  const changed =
    yield* sql`UPDATE whatsapp_invitations SET expires_at_ms=min(expires_at_ms,${now}),send_rejected=1 WHERE id=${id} AND message=${message} AND pairing_id IS NULL RETURNING id`;

  return changed.length === 1 ? noAction() : conflict();
});

const confirmReview = Effect.fn(function* (event: typeof WhatsAppBootstrapText.Type, text: string) {
  const sql = yield* SqliteClient;
  const code = reviewPattern.exec(text)?.[1];

  if (code === undefined) return conflict();
  const expected = text.replace(/^No vincular /u, "Vincular ");
  const choice = text === expected ? "confirmed" : "denied";
  const current = yield* Clock.currentTimeMillis;

  const changed =
    yield* sql`UPDATE whatsapp_invitations SET decision=${choice},confirmed_ms=${event.receivedAt},decision_message=${event.message}
      WHERE portfolio=${event.portfolio} AND bsuid=${event.bsuid} AND endpoint=${event.endpoint} AND review_code=${code} AND review_text=${expected} AND review_started_ms<${event.occurredAt} AND review_started_ms<${event.receivedAt} AND expires_at_ms>${current} AND decision IS NULL
      AND EXISTS(SELECT 1 FROM provider_attempts a WHERE a.id=review_attempt AND a.pairing_id=whatsapp_invitations.pairing_id AND a.invitation=whatsapp_invitations.id AND a.state='verified' AND a.expires_at_ms>${current}) RETURNING id`;

  return changed.length === 1 ? noAction() : conflict();
});

export const whatsappBootstrap = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const event = yield* Schema.decodeUnknownEffect(WhatsAppBootstrapText)(
    yield* Effect.tryPromise(() => request.json())
  );

  const text = event.text.trim();

  if (/^(Confirmo|Rechazo) asociación /u.test(text)) return conflict();

  const approval =
    /^Aprueba el código de inicio de sesión ([BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4})$/u.exec(
      text
    );

  if (approval?.[1] !== undefined) return yield* approveChannelPairing(event, approval[1], users);
  const confirmation = /^(?:Vincular|No vincular) (?:Google|Microsoft): /u.test(text);

  if (confirmation) {
    return yield* confirmReview(event, event.text);
  }

  const route = yield* prepareInvitation(event);

  if (isResponse(route)) return route;

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    portfolio: event.portfolio,
    bsuid: event.bsuid,
  });

  const check = yield* Effect.tryPromise((signal) =>
    users.getByName(route).fetch(localCallerUrl, { method: "POST", body, signal })
  );

  return check.ok ? Response.json({ userId: route }) : check;
});

export const whatsappOwner = Effect.fn(function* (request: Request) {
  const { portfolio, bsuid } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ portfolio: Schema.String, bsuid: Schema.String })
  )(yield* Effect.tryPromise(() => request.json()));

  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT user_id AS userId FROM whatsapp_routes WHERE portfolio=${portfolio} AND bsuid=${bsuid} AND established=1`;

  return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
});
