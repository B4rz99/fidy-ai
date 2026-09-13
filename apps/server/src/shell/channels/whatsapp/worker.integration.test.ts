import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { TestConsole } from "effect/testing";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  AgentService,
  HostedTurnProtocolFailed,
  HostedTurnUnavailable,
  WhatsAppInboundRoutingRejected,
} from "~/shell/agent/agent-service";
import { MigrationSqlClient, MigratorLive, PgLive } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { TestPublicNamespace } from "~/shell/testing/test-config";
import {
  WhatsAppInboundWork,
  whatsappInboundQueue,
  whatsappInboundQueueName,
} from "./inbound-execution";
import { WhatsAppInboundJobId } from "./model";
import { processNextWhatsAppTurn } from "./worker";

const WorkerHarness = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({ tableName: "fidy_queue", pollInterval: "10 millis" })
  ),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provide(MigratorLive),
  Layer.provideMerge(TelemetryEnvelopeRecording),
  Layer.provideMerge(BunServices.layer),
  Layer.merge(TestPublicNamespace),
  Layer.merge(TestConsole.layer)
);

const QueueRow = Schema.Struct({
  completed: Schema.Boolean,
  attempts: Schema.Int,
  lastFailure: Schema.OptionFromNullOr(Schema.String),
});

const cleanQueue = Effect.fn("Test.cleanWhatsAppWorkerQueue")(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM fidy_durable.fidy_queue WHERE queue_name = ${whatsappInboundQueueName}`;
});

const offerQueueWork = Effect.fn("Test.offerWhatsAppWorkerQueueWork")(function* (
  item: WhatsAppInboundWork
) {
  yield* cleanQueue();
  yield* Effect.addFinalizer(() => cleanQueue().pipe(Effect.orDie));
  const queue = yield* whatsappInboundQueue;
  yield* queue.offer(item, { id: item.inboundJobId });
});

const readOnlyQueueRow = Effect.fn("Test.readOnlyWhatsAppWorkerQueueRow")(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(Schema.Array(QueueRow))(
    yield* sql`SELECT completed, attempts, last_failure AS "lastFailure"
      FROM fidy_durable.fidy_queue WHERE queue_name = ${whatsappInboundQueueName}`
  ).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.die("expected one WhatsApp queue row")
        : Effect.succeed(rows[0])
    )
  );
});

const work = WhatsAppInboundWork.make({
  version: 1,
  userId: UserId.make("f1d1a000-0000-4000-8000-000000005501"),
  inboundJobId: WhatsAppInboundJobId.make("f1d1a000-0000-4000-8000-000000005502"),
});

const routingWork = WhatsAppInboundWork.make({
  version: 1,
  userId: UserId.make("f1d1a000-0000-4000-8000-000000005503"),
  inboundJobId: WhatsAppInboundJobId.make("f1d1a000-0000-4000-8000-000000005504"),
});

const agentWith = (
  handleWhatsAppWork: AgentService["Service"]["handleWhatsAppWork"]
): AgentService["Service"] => ({
  handleMessage: () => Effect.die("unexpected immediate agent call"),
  handleWhatsAppWork,
});

const seedInboundJob = Effect.fn("Test.seedWhatsAppInboundJob")(function* () {
  yield* seedConsentedPatIdentity({
    userId: work.userId,
    bearer: TokenBearer.make("fin_whats550_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
  });
  const sql = yield* MigrationSqlClient;
  yield* sql`INSERT INTO whatsapp_message_evidence
    (provider_message_id, user_id, direction, occurred_at)
    VALUES ('provider-identifier-terminal-sentinel', ${work.userId}, 'inbound', now())
    ON CONFLICT (provider_message_id) DO NOTHING`;
  yield* sql`INSERT INTO whatsapp_inbound_jobs
    (id, user_id, message_evidence_id, content, occurred_at, enqueued_at, debounce_until)
    VALUES (${work.inboundJobId}, ${work.userId},
      (SELECT id FROM whatsapp_message_evidence
        WHERE provider_message_id = 'provider-identifier-terminal-sentinel'),
      'terminal-message-text-sentinel', now(), now(), now())
    ON CONFLICT (id) DO UPDATE SET
      content = EXCLUDED.content, completed_at = NULL, terminal_outcome = NULL`;
});

layer(WorkerHarness, { excludeTestServices: true, timeout: "60 seconds" })(
  "WhatsApp inbound queue worker over PostgreSQL",
  (it) => {
    it.effect(
      "stores only the stable retry marker and consumes one attempt for transient transport failure",
      () =>
        Effect.gen(function* () {
          yield* offerQueueWork(work);
          const sensitive = "provider-transport-diagnostic-sentinel";

          yield* processNextWhatsAppTurn().pipe(
            Effect.provideService(
              AgentService,
              agentWith(() =>
                Effect.fail(new HostedTurnUnavailable({ cause: new Error(sensitive) }))
              )
            ),
            Effect.flip
          );

          const row = yield* readOnlyQueueRow();
          expect(row.completed).toBe(false);
          expect(row.attempts).toBe(1);
          expect(Option.getOrThrow(row.lastFailure)).toContain('"reason":"transient"');
          expect(Option.getOrThrow(row.lastFailure)).not.toContain(sensitive);
        })
    );

    it.effect(
      "records a bounded terminal disposition and completes a permanent protocol rejection",
      () =>
        Effect.gen(function* () {
          yield* offerQueueWork(work);
          yield* seedInboundJob();

          expect(
            yield* processNextWhatsAppTurn().pipe(
              Effect.provideService(
                AgentService,
                agentWith(() =>
                  Effect.fail(
                    new HostedTurnProtocolFailed({ cause: new Error("protocol-sentinel") })
                  )
                )
              )
            )
          ).toBe(true);

          const row = yield* readOnlyQueueRow();
          expect(row.completed).toBe(true);
          expect(row.attempts).toBe(1);
          expect(Option.isNone(row.lastFailure)).toBe(true);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT content, terminal_outcome AS "terminalOutcome"
              FROM whatsapp_inbound_jobs WHERE id = ${work.inboundJobId}`
          ).toEqual([{ content: null, terminalOutcome: "ambiguous_crash" }]);
        })
    );

    it.effect("completes a rejected identity without mutating unowned domain state", () =>
      Effect.gen(function* () {
        yield* offerQueueWork(routingWork);

        expect(
          yield* processNextWhatsAppTurn().pipe(
            Effect.provideService(
              AgentService,
              agentWith(() => Effect.fail(new WhatsAppInboundRoutingRejected()))
            )
          )
        ).toBe(true);

        const row = yield* readOnlyQueueRow();
        expect(row.completed).toBe(true);
        expect(row.attempts).toBe(1);
        expect(Option.isNone(row.lastFailure)).toBe(true);
        const terminalRecord = [
          ...(yield* TestConsole.logLines),
          ...(yield* TestConsole.errorLines),
        ].join("\n");
        expect(terminalRecord).toContain("identity-rejected");
        expect(terminalRecord).not.toContain(String(routingWork.userId));
        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`SELECT id FROM whatsapp_inbound_jobs
            WHERE id = ${routingWork.inboundJobId}`
        ).toEqual([]);
      })
    );

    it.effect("observes an unexpected defect once and stores only the redacted defect marker", () =>
      Effect.gen(function* () {
        yield* offerQueueWork(work);
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const sensitive = [
          "message-text-sentinel",
          "phone-provider-sentinel",
          String(work.userId),
          "sql-detail-sentinel",
          "model-diagnostic-sentinel",
          "secret-sentinel",
        ];

        const exit = yield* Effect.exit(
          processNextWhatsAppTurn().pipe(
            Effect.provideService(
              AgentService,
              agentWith(() => Effect.die(new Error(sensitive.join(" "))))
            )
          )
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const row = yield* readOnlyQueueRow();
        expect(row.attempts).toBe(1);
        expect(Option.getOrThrow(row.lastFailure)).toContain('"reason":"unexpected-defect"');
        const observed = [
          Option.getOrThrow(row.lastFailure),
          ...(yield* recorder.serializedEnvelopes).map((bytes) => new TextDecoder().decode(bytes)),
          ...(yield* TestConsole.logLines),
          ...(yield* TestConsole.errorLines),
        ].join("\n");
        for (const value of sensitive) expect(observed).not.toContain(value);
        expect(yield* recorder.serializedEnvelopes).toHaveLength(1);
      })
    );

    it.effect("preserves shutdown interruption without consuming an attempt", () =>
      Effect.gen(function* () {
        yield* offerQueueWork(work);

        const exit = yield* Effect.exit(
          processNextWhatsAppTurn().pipe(
            Effect.provideService(
              AgentService,
              agentWith(() => Effect.interrupt)
            )
          )
        );
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        const row = yield* readOnlyQueueRow();
        expect(row.completed).toBe(false);
        expect(row.attempts).toBe(0);
        expect(Option.isNone(row.lastFailure)).toBe(true);
      })
    );
  }
);
