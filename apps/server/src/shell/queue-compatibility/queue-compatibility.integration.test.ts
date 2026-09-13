import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Ref, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { UserId } from "~/core/identity/reference";
import { UnknownJsonString } from "~/schema-compatibility";
import {
  WhatsAppInboundWork,
  maximumWhatsAppInboundAttempts,
  whatsappInboundQueue,
  whatsappInboundQueueName,
} from "~/shell/channels/whatsapp/inbound-execution";
import { WhatsAppInboundJobId } from "~/shell/channels/whatsapp/model";
import { retireExhaustedWhatsAppWork } from "~/shell/channels/whatsapp/repo";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";

/**
 * PostgreSQL proof for the queue compatibility contract. The `whatsapp-inbound-turn`
 * queue carries the reviewed exhausted-item policy (`retireExhaustedWhatsAppWork`), so
 * these tests drive real rows through decode failure, exhaustion, retirement, and
 * mixed-version producer/consumer pairs, where the previous consumer is the previous
 * deployment's decoder with its required revision marker. Every test isolates its rows
 * by queue name and removes them afterwards so no other suite can observe fixtures.
 */
const CompatibilityHarness = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({ tableName: "fidy_queue", pollInterval: "10 millis" })
  ),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provide(MigratorLive),
  Layer.provideMerge(BunServices.layer)
);

/** The oldest supported encoding: markerless, keyed by the domain identity. */
const OldestWhatsAppInboundWork = Schema.Struct({
  userId: UserId,
  inboundJobId: WhatsAppInboundJobId,
});

/** The decoder that ran before the marker became optional: it required the revision. */
const PreviousWhatsAppInboundWork = Schema.Struct({
  version: Schema.Literal(1),
  userId: UserId,
  inboundJobId: WhatsAppInboundJobId,
});

/** A revision this deployment does not know; valid JSON the current schema must reject. */
const unknownFutureRevision = 99;

const QueueRowState = Schema.Struct({
  id: Schema.String,
  completed: Schema.Boolean,
  attempts: Schema.Int,
  lastFailure: Schema.OptionFromNullOr(Schema.String),
  element: Schema.String,
});

const cleanQueue = Effect.fn("Test.cleanCompatibilityQueue")(function* () {
  const admin = yield* MigrationSqlClient;
  yield* admin`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = ${whatsappInboundQueueName}`;
});

const readQueueRows = Effect.fn("Test.readCompatibilityQueueRows")(function* () {
  const admin = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(Schema.Array(QueueRowState))(
    yield* admin`SELECT id, completed, attempts, last_failure AS "lastFailure", element
      FROM fidy_durable.fidy_queue WHERE queue_name = ${whatsappInboundQueueName}
      ORDER BY sequence`
  );
});

const parseElement = Effect.fn("Test.parseCompatibilityElement")(function* (element: string) {
  return yield* Schema.decodeEffect(UnknownJsonString)(element);
});

const fixtureUrl = (file: string): URL => new URL(`./fixtures/${file}`, import.meta.url);

const readFixture = (file: string): Effect.Effect<string> =>
  Effect.promise(() => Bun.file(fixtureUrl(file)).text());

/** One successful take records its domain identity exactly once. */
const recordCompletion = (
  completions: Ref.Ref<number>,
  seen: Ref.Ref<ReadonlyArray<WhatsAppInboundWork>>
): ((work: WhatsAppInboundWork) => Effect.Effect<void>) =>
  Effect.fnUntraced(function* (work: WhatsAppInboundWork) {
    yield* Ref.updateAndGet(completions, (count) => count + 1);
    yield* Ref.update(seen, (values) => [...values, work]);
  });

layer(CompatibilityHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Queue compatibility over PostgreSQL",
  (it) => {
    it.effect("consumes attempts on decode failures and retires the exhausted row", () =>
      Effect.gen(function* () {
        yield* cleanQueue();
        yield* Effect.addFinalizer(() => cleanQueue().pipe(Effect.orDie));
        const userId = UserId.make("f1d1a000-0000-4000-8000-00000000c021");
        const inboundJobId = WhatsAppInboundJobId.make("f1d1a000-0000-4000-8000-00000000c022");
        const rowId = "f1d1a000-0000-4000-8000-00000000c023";
        const queue = yield* whatsappInboundQueue;
        yield* queue.offer(WhatsAppInboundWork.make({ version: 1, userId, inboundJobId }), {
          id: rowId,
        });
        const admin = yield* MigrationSqlClient;
        yield* admin`UPDATE fidy_durable.fidy_queue
          SET element = jsonb_set(element::jsonb, '{version}', '99')::text
          WHERE id = ${rowId} AND queue_name = ${whatsappInboundQueueName}`;
        for (let attempt = 0; attempt < maximumWhatsAppInboundAttempts; attempt += 1) {
          const error = yield* queue
            .take(() => Effect.void, { maxAttempts: maximumWhatsAppInboundAttempts })
            .pipe(Effect.flip);
          expect(Schema.isSchemaError(error), `attempt ${attempt}`).toBe(true);
        }
        const rows = yield* readQueueRows();
        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (row === undefined) return yield* Effect.die("expected compatibility row");
        expect(row.id).toBe(rowId);
        expect(row.completed).toBe(false);
        expect(row.attempts).toBe(maximumWhatsAppInboundAttempts);
        expect(Option.isSome(row.lastFailure)).toBe(true);
        expect(yield* parseElement(row.element)).toEqual({
          version: unknownFutureRevision,
          userId,
          inboundJobId,
        });
        // The exhausted row is no longer eligible: the consumer observes absence,
        // never a silent drop.
        const missed = yield* queue
          .take(() => Effect.void, { maxAttempts: maximumWhatsAppInboundAttempts })
          .pipe(Effect.timeoutOption("500 millis"));
        expect(Option.isNone(missed)).toBe(true);
        // The reviewed exhausted-item policy retires the row with its domain identity
        // instead of leaving it stranded behind the attempt ceiling.
        const retired = yield* retireExhaustedWhatsAppWork(yield* DateTime.now);
        expect(retired).toEqual([{ userId, inboundJobId }]);
        const retiredRows = yield* readQueueRows();
        expect(retiredRows).toHaveLength(1);
        expect(retiredRows[0]?.completed).toBe(true);
      })
    );

    it.effect(
      "retains malformed exhausted elements as schema_incompatible and retires decodable ones",
      () =>
        Effect.gen(function* () {
          yield* cleanQueue();
          yield* Effect.addFinalizer(() => cleanQueue().pipe(Effect.orDie));
          const admin = yield* MigrationSqlClient;
          yield* admin`INSERT INTO fidy_durable.fidy_queue
          (id, queue_name, element, completed, attempts, created_at, updated_at)
          VALUES ('f1d1a000-0000-4000-8000-00000000c024', ${whatsappInboundQueueName},
            'not-json', FALSE, ${maximumWhatsAppInboundAttempts}, now(), now())`;
          const userId = UserId.make("f1d1a000-0000-4000-8000-00000000c025");
          const inboundJobId = WhatsAppInboundJobId.make("f1d1a000-0000-4000-8000-00000000c026");
          const queue = yield* whatsappInboundQueue;
          yield* queue.offer(WhatsAppInboundWork.make({ version: 1, userId, inboundJobId }), {
            id: inboundJobId,
          });
          yield* admin`UPDATE fidy_durable.fidy_queue SET attempts = ${maximumWhatsAppInboundAttempts}
          WHERE id = ${inboundJobId} AND queue_name = ${whatsappInboundQueueName}`;
          const retired = yield* retireExhaustedWhatsAppWork(yield* DateTime.now);
          expect(retired).toEqual([{ userId, inboundJobId }]);
          const rows = yield* readQueueRows();
          expect(rows).toHaveLength(2);
          const [malformed, wellFormed] = rows;
          if (malformed === undefined || wellFormed === undefined) {
            return yield* Effect.die("expected retired compatibility rows");
          }
          expect(malformed.completed).toBe(false);
          expect(Option.contains(malformed.lastFailure, "schema_incompatible")).toBe(true);
          expect(malformed.element).toBe("not-json");
          expect(wellFormed.completed).toBe(true);
          expect(Option.isNone(wellFormed.lastFailure)).toBe(true);
          expect(yield* parseElement(wellFormed.element)).toEqual({
            version: 1,
            userId,
            inboundJobId,
          });
        })
    );

    it.effect(
      "completes an oldest-encoding row once under the current consumer despite duplicates",
      () =>
        Effect.gen(function* () {
          yield* cleanQueue();
          yield* Effect.addFinalizer(() => cleanQueue().pipe(Effect.orDie));
          const oldElement = yield* readFixture("whatsapp-inbound-turn.json");
          const oldJson = yield* parseElement(oldElement);
          const old = yield* Schema.decodeUnknownEffect(OldestWhatsAppInboundWork)(oldJson);
          const admin = yield* MigrationSqlClient;
          // The oldest supported bytes: markerless and keyed by the domain identity.
          yield* admin`INSERT INTO fidy_durable.fidy_queue
          (id, queue_name, element, completed, attempts, created_at, updated_at)
          VALUES (${old.inboundJobId}, ${whatsappInboundQueueName}, ${oldElement},
            FALSE, 0, now(), now())`;
          const queue = yield* whatsappInboundQueue;
          // A new-deployment duplicate offer converges on the old row instead of forking work.
          const decoded = yield* Schema.decodeUnknownEffect(WhatsAppInboundWork)(oldJson);
          yield* queue.offer(decoded, { id: old.inboundJobId });
          const afterOffer = yield* readQueueRows();
          expect(afterOffer).toHaveLength(1);
          expect(afterOffer[0]?.element).toBe(oldElement);
          const completions = yield* Ref.make(0);
          const seen = yield* Ref.make<ReadonlyArray<WhatsAppInboundWork>>([]);
          yield* queue.take(recordCompletion(completions, seen));
          expect(yield* Ref.get(completions)).toBe(1);
          const [work] = yield* Ref.get(seen);
          expect(work?.version).toBe(1);
          expect(work?.userId).toBe(old.userId);
          expect(work?.inboundJobId).toBe(old.inboundJobId);
          const [row] = yield* readQueueRows();
          expect(row?.completed).toBe(true);
          expect(row?.attempts).toBe(1);
          const redelivered = yield* queue
            .take(() => Effect.void)
            .pipe(Effect.timeoutOption("500 millis"));
          expect(Option.isNone(redelivered)).toBe(true);
          expect(yield* Ref.get(completions)).toBe(1);
        })
    );

    it.effect("keeps a new-producer row readable to the previous consumer", () =>
      Effect.gen(function* () {
        yield* cleanQueue();
        yield* Effect.addFinalizer(() => cleanQueue().pipe(Effect.orDie));
        const userId = UserId.make("f1d1a000-0000-4000-8000-00000000c027");
        const inboundJobId = WhatsAppInboundJobId.make("f1d1a000-0000-4000-8000-00000000c028");
        const queue = yield* whatsappInboundQueue;
        yield* queue.offer(WhatsAppInboundWork.make({ version: 1, userId, inboundJobId }), {
          id: inboundJobId,
        });
        const previousQueue = yield* PersistedQueue.make({
          name: whatsappInboundQueueName,
          schema: PreviousWhatsAppInboundWork,
        });
        const seen = yield* Ref.make(Option.none<typeof PreviousWhatsAppInboundWork.Type>());
        yield* previousQueue.take((work) => Ref.set(seen, Option.some(work)));
        const decoded = yield* Ref.get(seen).pipe(Effect.flatMap(Effect.fromOption));
        // The previous decoder required the marker; the current producer still writes it.
        expect(decoded).toEqual({ version: 1, userId, inboundJobId });
        const [row] = yield* readQueueRows();
        expect(row?.completed).toBe(true);
      })
    );
  }
);
