import {
  captureWorkTrace,
  sanitizeWorkTrace,
  workTraceHeaders,
} from "../../runtime/telemetry/operations";
import { TranscriptTurnId } from "../../../src/core/agent/contract";
import { UserId } from "../../../src/core/identity/contract";
import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { hostedChannelTurnObservation } from "../../agent/operations";
import { WhatsAppWork } from "../contract";

const outboxLimit = 32;
const offerCooldownMs = 60_000;
const serverFailureStatus = 500;
const concurrentUsers = 4;
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
    const trace = yield* captureWorkTrace;
    const now = yield* Clock.currentTimeMillis;
    const selectedUser = Option.getOrNull(userId);
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT o.user_id, o.turn_id
      FROM (SELECT rowid,id AS turn_id,user_id,dispatch_offered_at_ms AS offered_at_ms,dispatch_created_at_ms AS created_at_ms FROM hosted_turns WHERE inbound_message_id IS NOT NULL AND dispatch_created_at_ms IS NOT NULL) AS o JOIN (${hostedChannelTurnObservation()}) AS t ON t.id = o.turn_id
      WHERE t.status = 'pending' AND (o.offered_at_ms IS NULL OR o.offered_at_ms < ?)
        AND (? IS NULL OR o.user_id = ?)
      ORDER BY o.created_at_ms LIMIT ?`)
        .bind(now - offerCooldownMs, selectedUser, selectedUser, outboxLimit)
        .all()
    );
    const work = yield* Schema.decodeUnknownEffect(Schema.Array(OutboxEntry))(raw.results);
    let failed = false;
    for (const entry of work) {
      const claim = yield* Effect.exit(
        Effect.tryPromise(() =>
          db
            .prepare(`UPDATE hosted_turns AS hosted_whatsapp_outbox SET dispatch_offered_at_ms = ? WHERE dispatch_created_at_ms IS NOT NULL AND id = ? AND user_id = ?
          AND (dispatch_offered_at_ms IS NULL OR dispatch_offered_at_ms < ?)`)
            .bind(now, entry.turn_id, entry.user_id, now - offerCooldownMs)
            .run()
        )
      );
      if (Exit.isFailure(claim)) {
        if (Cause.hasInterrupts(claim.cause)) return yield* Effect.failCause(claim.cause);
        failed = true;
        continue;
      }
      if (claim.value.meta.changes !== 1) continue;
      const offered = yield* Effect.exit(
        Effect.tryPromise(() =>
          queue.send({
            ...trace,
            _tag: "HostedWhatsAppWork",
            userId: entry.user_id,
            turnId: entry.turn_id,
          } satisfies WhatsAppWork)
        )
      );
      if (Exit.isFailure(offered)) {
        if (Cause.hasInterrupts(offered.cause)) return yield* Effect.failCause(offered.cause);
        failed = true;
      }
    }
    if (failed) return yield* Effect.fail(undefined);
  });

type WorkMessage = Readonly<{
  body: unknown;
  ack: () => void;
  retry: () => void;
}>;
type Coordinator = Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;

const receiveOwnedWork = (
  { message, work }: Readonly<{ message: WorkMessage; work: WhatsAppWork }>,
  coordinator: Coordinator
): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const payload = yield* sanitizeWorkTrace(work);
    const traceHeaders = yield* workTraceHeaders(payload);
    const owner = coordinator.getByName(work.userId);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(WhatsAppWork))(payload);
    const response = yield* Effect.exit(
      Effect.tryPromise(() =>
        owner.fetch(
          new Request("https://coordinator.internal/hosted-turn/whatsapp/work", {
            method: "POST",
            headers: traceHeaders,
            body,
          })
        )
      )
    );
    if (Exit.isFailure(response) && Cause.hasInterrupts(response.cause)) {
      return yield* Effect.failCause(response.cause);
    }
    if (Exit.isFailure(response) || response.value.status >= serverFailureStatus) {
      message.retry();
      return;
    }
    message.ack();
  });

/** Bound unrelated User dispatch without reordering one User's messages; its coordinator owns execution serialization. */
export const receiveWhatsAppWork = ({
  messages,
  coordinator,
}: Readonly<{
  messages: ReadonlyArray<WorkMessage>;
  coordinator: Coordinator;
}>): Effect.Effect<void, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const users = new Map<UserId, Array<Readonly<{ message: WorkMessage; work: WhatsAppWork }>>>();
    for (const message of messages) {
      const work = Schema.decodeUnknownOption(WhatsAppWork)(message.body);
      if (Option.isNone(work)) {
        message.ack();
        continue;
      }
      const owned = users.get(work.value.userId) ?? [];
      owned.push({ message, work: work.value });
      users.set(work.value.userId, owned);
    }
    yield* Effect.forEach(
      users.values(),
      (owned) =>
        Effect.forEach(owned, (entry) => receiveOwnedWork(entry, coordinator), { discard: true }),
      { concurrency: concurrentUsers, discard: true }
    );
  });
