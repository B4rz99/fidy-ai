import { visibleChallenge } from "./local-challenge";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import { TranscriptText, TranscriptTurnId } from "../../../src/core/agent/contract";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../../src/core/identity/contract";
import { HostedDeliveryCorrelationToken } from "../../../src/shell/channels/whatsapp/contract";
import { HostedSender } from "../../../src/shell/channels/whatsapp/runtime";
import { OutboundHttpLive } from "../../outbound-http/runtime";
import type { ExternalEventBindings } from "../../directory/contract";
import { claimRegisteredSend, recordRegisteredSend } from "../../whatsapp/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const retryMs = 5000;

const channel = Schema.Struct({
  id: TranscriptTurnId,
  user_id: UserId,
  bsuid: WhatsAppBusinessScopedUserId,
  endpoint: WhatsAppBusinessPhoneNumberId,
  portfolio: WhatsAppBusinessPortfolioId,
  sandbox_phone: Schema.NullOr(E164PhoneNumber),
  correlation: HostedDeliveryCorrelationToken,
  answer: TranscriptText,
  deadline_ms: Schema.Int,
});

type ChannelEnvironment = ExternalEventBindings & { KAPSO_API_KEY: string } & Partial<{
    WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
  }>;

const takeOffer = Effect.fn(function* (
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const now = yield* Clock.currentTimeMillis,
    sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT t.id,t.user_id,t.answer,t.deadline_ms,i.bsuid,i.endpoint,i.portfolio,i.sandbox_phone,i.correlation FROM hosted_turns t JOIN hosted_whatsapp_inbound i ON i.turn_id=t.id AND i.user_id=t.user_id WHERE t.state='proposed' AND t.deadline_ms>${now} AND i.offer_ms<=${now} AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries w WHERE w.user_id=t.user_id AND w.operation_id=t.id AND w.family='hosted' AND w.started_ms IS NOT NULL)`;

  if (raw === undefined) return Option.none();
  const row = yield* Schema.decodeUnknownEffect(channel)(raw);

  if (!owns(row.user_id)) return Option.none();
  const next = Math.min(now + retryMs, row.deadline_ms);

  const claimed =
    yield* sql`UPDATE hosted_whatsapp_inbound SET offer_ms=${next} WHERE turn_id=${row.id} AND offer_ms<=${now} RETURNING turn_id`;

  if (claimed.length !== 1) return Option.none();
  yield* preserveStoreAlarm(storage, next);

  return Option.some(row);
});

const hostedSender = Effect.fn(function* (env: ChannelEnvironment) {
  const clients = yield* Layer.build(OutboundHttpLive);

  return yield* HostedSender.make({
    apiKey: Redacted.make(env.KAPSO_API_KEY),
    sandboxPhoneNumberId: Option.fromUndefinedOr(env.WHATSAPP_SANDBOX_PHONE_NUMBER_ID),
    httpClient: Context.get(clients, HttpClient.HttpClient),
  });
});

export const offerChannel = Effect.fn(function* (
  env: ChannelEnvironment,
  storage: DurableObjectStorage,
  owns: (id: string) => boolean
) {
  const offered = yield* takeOffer(storage, owns).pipe(withStoreCapacity("required"));

  if (Option.isNone(offered)) return { attempted: 0, failed: 0 };
  const row = offered.value;

  const binding = {
    userId: row.user_id,
    operationId: row.id,
    family: "hosted" as const,
    endpoint: row.endpoint,
    correlation: row.correlation,
  };

  const claim = yield* claimRegisteredSend(env, {
    ...binding,
    bsuid: row.bsuid,
    portfolio: row.portfolio,
    sandboxPhone: row.sandbox_phone,
    deadline: row.deadline_ms,
    content: row.answer,
  });

  const sender = yield* hostedSender(env);

  const challenge = yield* visibleChallenge(row.id, yield* Clock.currentTimeMillis);
  yield* claim.claim;

  const result = yield* Effect.exit(
    sender({
      text: row.answer,
      recipient: row.bsuid,
      businessPhoneNumberId: row.endpoint,
      correlationToken: row.correlation,
      sandboxPhone: Option.fromNullishOr(row.sandbox_phone),
      confirmation: Option.map(challenge, ({ command }) => ({ command })),
    })
  );

  if (Exit.isSuccess(result)) {
    yield* recordRegisteredSend(env, {
      ...binding,
      state: "accepted",
      message: result.value.messageEvidence.providerMessageId,
    });
  } else {
    const reason = Option.map(
      Cause.findErrorOption(result.cause),
      (error) => error.deliveryCertainty
    );

    yield* recordRegisteredSend(env, {
      ...binding,
      state: Option.getOrElse(reason, () => "ambiguous" as const),
      message: null,
    });
  }

  return { attempted: 1, failed: 0 };
}, Effect.scoped);
