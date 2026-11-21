import { type ReadonlyMoney, encodeMoneyAmount } from "~/core/_shared/money";
import { listLaunchCategories } from "~/core/categories/operations";
import {
  WhatsAppBatchTooLarge,
  WhatsAppDeliveryKey,
  type WhatsAppIdentityChangeEvent,
  type WhatsAppLifecycleAuthentication,
  type WhatsAppWebhookReceipt,
  maxWhatsAppDeliveryEvents,
} from "./contract";
import { DateTime, Effect, Array as EffectArray, Option, type Redacted, Schema } from "effect";
import { WhatsAppBusinessPortfolioId } from "~/core/identity/contract";
import {
  RawKapsoEnvelope,
  RawMetaEnvelope,
  authenticateAndDecodeKapsoBody,
  decodeLifecycleStatus,
  invalidKapsoPayload,
  projectEvent,
  projectHostedStatus,
  projectIdentityChange,
} from "~/shell/channels/whatsapp/internal/kapso-webhook";

export const authenticateWhatsAppInbound = Effect.fn(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted<string>;
  readonly signature: string;
  readonly deliveryKey: string;
  readonly businessPortfolioId: string;
  readonly receivedAt: DateTime.Utc;
}) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);

  const deliveryKey = yield* Schema.decodeEffect(WhatsAppDeliveryKey)(input.deliveryKey).pipe(
    Effect.mapError(invalidKapsoPayload)
  );

  const businessPortfolioId = yield* Schema.decodeEffect(WhatsAppBusinessPortfolioId)(
    input.businessPortfolioId
  ).pipe(Effect.mapError(invalidKapsoPayload));

  const envelope = yield* Schema.decodeUnknownEffect(RawKapsoEnvelope)(unknown).pipe(
    Effect.mapError(invalidKapsoPayload)
  );

  const rawEvents = "data" in envelope ? envelope.data : [envelope];

  if (rawEvents.length > maxWhatsAppDeliveryEvents) {
    return yield* new WhatsAppBatchTooLarge();
  }

  const events = yield* Effect.forEach(
    rawEvents,
    (event) => projectEvent(event, businessPortfolioId, input.receivedAt),
    {
      concurrency: 1,
    }
  ).pipe(Effect.mapError(invalidKapsoPayload));

  const [first, ...rest] = events;

  return { deliveryKey, events: [first, ...rest] } satisfies WhatsAppWebhookReceipt;
});

export const authenticateHostedStatus = Effect.fn(function* (
  input: WhatsAppLifecycleAuthentication
) {
  const latest = yield* decodeLifecycleStatus(input);

  if (Option.isNone(latest)) return yield* invalidKapsoPayload("uncorrelated hosted status");

  return projectHostedStatus(latest.value);
});

export const authenticateDisclosureStatus = Effect.fn(function* (
  input: WhatsAppLifecycleAuthentication
) {
  const latest = yield* decodeLifecycleStatus(input);

  if (Option.isNone(latest)) return yield* invalidKapsoPayload("uncorrelated disclosure status");

  return { ...latest.value.evidence, businessPhoneNumberId: latest.value.businessPhoneNumberId };
});

export const authenticateIdentityChange = Effect.fn(function* (input: {
  readonly rawBody: Uint8Array;
  readonly secret: Redacted.Redacted<string>;
  readonly signature: string;
  readonly businessPortfolioId: string;
  readonly receivedAt: DateTime.Utc;
}) {
  const unknown = yield* authenticateAndDecodeKapsoBody(input);

  const businessPortfolioId = yield* Schema.decodeEffect(WhatsAppBusinessPortfolioId)(
    input.businessPortfolioId
  ).pipe(Effect.mapError(invalidKapsoPayload));

  const envelope = yield* Schema.decodeUnknownEffect(RawMetaEnvelope)(unknown).pipe(
    Effect.mapError(invalidKapsoPayload)
  );

  const messages = envelope.entry.flatMap((entry) =>
    entry.changes.flatMap((change) => change.value.messages ?? [])
  );

  if (messages.length > maxWhatsAppDeliveryEvents) return yield* new WhatsAppBatchTooLarge();

  const projected = yield* Effect.forEach(
    messages,
    (message) => projectIdentityChange(message, businessPortfolioId, input.receivedAt),
    { concurrency: 1 }
  );

  const changes: ReadonlyArray<WhatsAppIdentityChangeEvent> = EffectArray.getSomes(projected);

  return changes;
});

export const formatWhatsAppMoney = (money: ReadonlyMoney): string => {
  const [whole = "", fraction] = encodeMoneyAmount(money.amount).split(".");
  const amount = `${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ".")}${fraction === undefined ? "" : `,${fraction}`}`;

  return `${amount} ${money.currency === "COP" ? "pesos" : money.currency}`;
};

const months = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export const formatWhatsAppDate = (date: string): string => {
  const [year, month, day] = date.split("-");

  return `${Number(day)} de ${months[Number(month) - 1]} de ${year}`;
};

export const formatWhatsAppLocalDate = ({
  date,
  timeZone,
}: Readonly<{ date: DateTime.Utc; timeZone: string }>): Option.Option<string> =>
  Option.map(DateTime.setZoneNamed(date, timeZone), (local) =>
    formatWhatsAppDate(DateTime.formatIsoDate(local))
  );

export const formatWhatsAppCategory = (id: string): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(listLaunchCategories().find((category) => category.id === id)),
    ({ label }) => label
  );
