import { TranscriptTurnId } from "@fidy/server/agent-contract";
import { UserId } from "@fidy/server/identity-reference";
import { type Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { hostedChannelTurnObservation } from "../../agent/operations";
import { WhatsAppWork } from "../contract";

const outboxLimit = 32;
const offerCooldownMs = 60_000;
const serverFailureStatus = 500;
const OutboxEntry = Schema.Struct({ user_id: UserId, turn_id: TranscriptTurnId });

/** A missed publication is reoffered by cron; duplicate offers are harmless at the User owner. */
export const dispatchWhatsAppWork = ({
  db,
  queue,
  userId,
}: Readonly<{
  db: D1Database;
  queue: Readonly<{ send: (work: WhatsAppWork) => Promise<unknown> }>;
  userId: Option.Option<UserId>;
}>): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError | void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT o.user_id, o.turn_id
      FROM hosted_whatsapp_outbox AS o JOIN (${hostedChannelTurnObservation()}) AS t ON t.id = o.turn_id
      WHERE t.status = 'pending' AND (o.offered_at_ms IS NULL OR o.offered_at_ms < ?)
        AND (? IS NULL OR o.user_id = ?)
      ORDER BY o.created_at_ms LIMIT ?`)
        .bind(
          now - offerCooldownMs,
          Option.getOrNull(userId),
          Option.getOrNull(userId),
          outboxLimit
        )
        .all()
    );
    const work = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxEntry))(raw.results);
    let failed = false;
    for (const entry of work) {
      const claim = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare(`UPDATE hosted_whatsapp_outbox
        SET offered_at_ms = ? WHERE turn_id = ? AND user_id = ?
          AND (offered_at_ms IS NULL OR offered_at_ms < ?)`)
            .bind(now, entry.turn_id, entry.user_id, now - offerCooldownMs)
            .run()
        )
      );
      if (Exit.isFailure(claim)) {
        failed = true;
        continue;
      }
      if (claim.value.meta.changes !== 1) continue;
      const offered = yield* Effect.exit(
        Effect.tryPromise(() =>
          queue.send({
            _tag: "HostedWhatsAppWork",
            userId: entry.user_id,
            turnId: entry.turn_id,
          } satisfies WhatsAppWork)
        )
      );
      if (Exit.isFailure(offered)) failed = true;
    }
    if (failed) return yield* Effect.fail(undefined);
  });

/** Queue redelivery is serialized by the same User coordinator as webhook admission. */
export const receiveWhatsAppWork = ({
  messages,
  coordinator,
}: Readonly<{
  messages: ReadonlyArray<
    Readonly<{
      body: unknown;
      ack: () => void;
      retry: () => void;
    }>
  >;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    for (const message of messages) {
      const work = Schema.decodeUnknownOption(WhatsAppWork)(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      const owner = coordinator.getByName(work.value.userId);
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppWork))(work.value);
      const response = yield* Effect.exit(
        Effect.tryPromise(() =>
          owner.fetch(
            new Request("https://coordinator.internal/hosted-turn/whatsapp/work", {
              method: "POST",
              body,
            })
          )
        )
      );
      if (Exit.isFailure(response) || response.value.status >= serverFailureStatus) {
        message.retry();
        continue;
      }
      message.ack();
    }
  });
