import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { voiceUnavailableSender } from "../../../src/shell/channels/whatsapp/runtime";
import { VoiceRefusal } from "../contract";

const endOfProviderSecond = 999;

const hourMs = 3_600_000,
  retentionMs = 604_800_000,
  maximum = 5;

const accepted = 200,
  claimed = 201,
  unknown = 503,
  limited = 429;

type Inbound = typeof VoiceRefusal.Type;

const claim = Effect.fn(function* (work: Inbound, current: number, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const live = protectConsentStatement({
    subject: ConsentSubject.User({ userId: work.userId }),
    requirement: "active",
    statement: {
      sql: "SELECT 1 FROM users WHERE id=? AND whatsapp_portfolio_id=? AND whatsapp_bsuid=? AND whatsapp_verified_at_ms<=? AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
      params: [
        work.userId,
        work.caller.businessPortfolioId,
        work.caller.businessScopedUserId,
        work.occurredAt + endOfProviderSecond,
      ],
    },
  });

  if ((yield* sql.unsafe(live.sql, live.params)).length !== 1) return limited;

  const [prior] =
    yield* sql`SELECT outcome FROM whatsapp_voice_refusals WHERE user_id=${work.userId} AND portfolio=${work.caller.businessPortfolioId} AND message=${work.message}`;

  if (prior !== undefined) return prior.outcome === "accepted" ? accepted : unknown;

  const fresh =
    yield* sql`INSERT INTO whatsapp_voice_refusals(portfolio,message,user_id,claimed_ms,outcome) SELECT ${work.caller.businessPortfolioId},${work.message},${work.userId},${current},'started' WHERE (SELECT count(*) FROM whatsapp_voice_refusals WHERE user_id=${work.userId} AND claimed_ms>${current - hourMs})<${maximum} RETURNING 1`;

  if (fresh.length !== 1) return limited;
  yield* preserveStoreAlarm(storage, current + retentionMs);

  return claimed;
});

export const refuseVoice = Effect.fn(function* ({
  request,
  environment,
  owns,
  storage,
}: {
  request: Request;
  environment: { KAPSO_API_KEY: string } & Partial<
    Readonly<{ WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string }>
  >;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
}) {
  const work = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(VoiceRefusal))(
    yield* Effect.tryPromise(() => request.json())
  );

  if (!owns(work.userId) || environment.KAPSO_API_KEY.length === 0) {
    return new Response(null, { status: unknown });
  }

  const status = yield* claim(work, yield* Clock.currentTimeMillis, storage).pipe(
    withStoreCapacity("growth")
  );

  if (status !== claimed) return new Response(null, { status });

  const httpClient = yield* HttpClient.HttpClient,
    sent = yield* Effect.result(
      voiceUnavailableSender({
        apiKey: Redacted.make(environment.KAPSO_API_KEY),
        sandboxPhoneNumberId: Option.fromUndefinedOr(
          environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID
        ).pipe(Option.filter((id) => id.length > 0)),
        httpClient,
      })({ caller: work.caller, phoneNumberId: work.endpoint })
    ).pipe(Effect.withSpan("whatsapp.voice.refusal"));

  const sql = yield* SqliteClient;

  const applied = yield* withStoreCapacity("required")(
    sql`UPDATE whatsapp_voice_refusals SET outcome=${Result.isSuccess(sent) ? "accepted" : "failed"} WHERE portfolio=${work.caller.businessPortfolioId} AND message=${work.message} AND user_id=${work.userId} AND outcome='started' RETURNING 1`
  );

  return new Response(null, {
    status: Result.isSuccess(sent) && applied.length === 1 ? accepted : unknown,
  });
});
