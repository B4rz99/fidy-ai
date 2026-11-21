import type { OpenAiEnvironment } from "../../ai/contract";
import { preflightRefusal, validateAdmission } from "./local-inference";
import { observedReminderChoice } from "../../insights/runtime";
import type { NativeReminderEnvironment } from "../../insights/contract";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { TranscriptText } from "../../../src/core/agent/contract";
import { hostedSessionIdleMilliseconds } from "../../../src/core/agent/operations";
import { UserId } from "../../../src/core/identity/contract";
import type { NativeStatementDocument } from "../../ingestion/contract";
import { retainLocalStatementDocumentOrigin } from "../../ingestion/operations";
import { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import { newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { AgentUnavailable } from "../contract";
import {
  beginTurn,
  channelReply,
  channelStatus,
  isResponse,
  unavailable,
} from "./local-turn-store";

const dayMs = 86400000,
  futureToleranceMs = 300000,
  timestampResolutionMs = 1000;

type Inbound = {
  userId: string;
  portfolio: string;
  bsuid: string;
  message: string;
  endpoint: string;
  occurredAt: number;
  receivedAt: number;
  text: TranscriptText;
  reply: Option.Option<string>;
  phone: Option.Option<string>;
  media: Option.Option<string>;
};

const accept = Effect.fn(function* (event: Inbound, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const [live] =
    yield* sql`SELECT 1 FROM users WHERE id=${event.userId} AND whatsapp_portfolio_id=${event.portfolio} AND whatsapp_bsuid=${event.bsuid} AND whatsapp_verified_at_ms<=${event.occurredAt + timestampResolutionMs - 1} AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${event.userId})`;

  if (
    live === undefined ||
    event.occurredAt + dayMs <= now ||
    event.occurredAt > Math.min(now, event.receivedAt) + futureToleranceMs
  ) {
    return channelReply(channelStatus.forbidden)({ status: "user_action_required" });
  }

  const [prior] =
    yield* sql`SELECT t.id,(i.bsuid=${event.bsuid} AND i.endpoint=${event.endpoint} AND i.occurred_ms=${event.occurredAt} AND i.media_id IS ${Option.getOrNull(event.media)} AND i.sandbox_phone IS ${Option.getOrNull(event.phone)} AND i.reply_to IS ${Option.getOrNull(event.reply)} AND t.request_text=${event.text}) AS exact FROM hosted_whatsapp_inbound i JOIN hosted_turns t ON t.id=i.turn_id AND t.user_id=i.user_id WHERE i.user_id=${event.userId} AND i.portfolio=${event.portfolio} AND i.message=${event.message}`;

  if (prior !== undefined) {
    return channelReply(prior.exact === 1 ? channelStatus.accepted : channelStatus.conflict)({
      status: "retained",
    });
  }

  const turn = yield* beginTurn({ userId: event.userId, id: Option.none() }, event.text, storage);

  if (isResponse(turn)) return turn;
  yield* sql`INSERT INTO hosted_whatsapp_inbound(turn_id,user_id,portfolio,bsuid,message,endpoint,occurred_ms,reply_to,sandbox_phone,media_id,correlation) VALUES(${turn.id},${turn.user_id},${event.portfolio},${event.bsuid},${event.message},${event.endpoint},${event.occurredAt},${Option.getOrNull(event.reply)},${Option.getOrNull(event.phone)},${Option.getOrNull(event.media)},${newId()})`;

  return turn;
});

export const hostedDocument = Effect.fn(
  function* (doc: typeof NativeStatementDocument.Type, storage: DurableObjectStorage) {
    const turn = yield* accept(
      {
        ...doc,
        text: TranscriptText.make("Adjunté un estado de cuenta para procesar."),
        media: Option.some(doc.mediaId),
        reply: Option.none(),
        phone: Option.none(),
      },
      storage
    );

    if (isResponse(turn)) return Option.some(turn);

    if (
      !(yield* retainLocalStatementDocumentOrigin({
        user: UserId.make(doc.userId),
        sessionId: turn.session_id,
        turnId: turn.id,
        message: doc.message,
        occurredAt: doc.occurredAt,
        expiresAt: doc.occurredAt + hostedSessionIdleMilliseconds,
      }))
    ) {
      return yield* new AgentUnavailable();
    }

    return Option.none<Response>();
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);

export const hostedText = Effect.fn(
  function* (
    request: Request,
    owns: (id: string) => boolean,
    {
      storage,
      env,
    }: { storage: DurableObjectStorage; env: NativeReminderEnvironment & OpenAiEnvironment }
  ) {
    const event = yield* Schema.decodeUnknownEffect(WhatsAppTurnAdmission)(
      yield* Effect.tryPromise(() => request.json())
    );

    if (!owns(event.userId)) {
      return channelReply(channelStatus.forbidden)({ status: "unauthenticated" });
    }

    const choice = yield* observedReminderChoice(event, env, storage);

    if (Option.isSome(choice)) return choice.value;

    return yield* accept(
      {
        userId: event.userId,
        portfolio: event.portfolioId,
        bsuid: event.bsuid,
        message: event.messageId,
        endpoint: event.businessPhoneNumberId,
        occurredAt: event.occurredAtMs,
        receivedAt: event.receivedAtMs,
        text: event.text,
        media: Option.none(),
        phone: event.sandboxPhone,
        reply: event.replyToMessageId,
      },
      storage
    ).pipe(
      Effect.flatMap((turn) => validateAdmission(env, turn)),
      withStoreCapacity("growth")
    );
  },
  Effect.catchTag("HostedInferenceError", (err) => Effect.succeed(preflightRefusal(err))),
  Effect.catchCause(() => Effect.succeed(unavailable()))
);
