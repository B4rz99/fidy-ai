import { expect, layer } from "@effect/vitest";
import { UnknownJsonString } from "~/schema-compatibility";
import {
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { RunnerAddress, ShardId, Sharding } from "effect/unstable/cluster";
import { HttpClient } from "effect/unstable/http";
import { PersistedQueue } from "effect/unstable/persistence";
import { SqlClient } from "effect/unstable/sql";
import { pruneCompletedHostedTurnMessages } from "~/shell/durable-execution-retention";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { TranscriptText, TranscriptTurnId } from "~/core/transcript/model";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import {
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedPatIdentity,
  seedDevelopmentIdentity,
} from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { TestPublicNamespace } from "~/shell/testing/test-config";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import {
  type AgentReply,
  AgentService,
  type AgentTurnError,
  CurrentAgentLimits,
  InboundMessage,
} from "./agent-service";
import { HostedTurns } from "./hosted-turns";
import { HostedInference, type HostedTextContext, makeHostedInference } from "./hosted-inference";
import { ImmediateDelivery } from "./immediate-delivery";
import { WhatsAppReplyDeliveryLive } from "./whatsapp-delivery";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  WhatsAppInboundJobId,
  WhatsAppProviderMessageId,
} from "~/shell/channels/whatsapp/model";
import { enqueueWhatsAppTurn } from "~/shell/channels/whatsapp/repo";
import { WhatsAppInboundWork } from "~/shell/channels/whatsapp/inbound-execution";
import { WhatsAppWorkerLive, processNextWhatsAppTurn } from "~/shell/channels/whatsapp/worker";
import { truncateWhatsAppChannel } from "~/shell/channels/whatsapp/fixtures";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";

const SqlWhatsAppQueueLive = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreSql({ tableName: "fidy_queue" }))
);

const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000465");
const token = Redacted.make("a".repeat(64));
// Two owners need a few shards, not production cardinality within a 500ms test lease refresh.
const testShardCount = 16;
const TurnRows = Schema.Array(Schema.Struct({ state: Schema.String }));
const backendPid = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ pid: Schema.Int })))(
    yield* sql`SELECT pg_backend_pid() AS pid`
  );
});
const mailbox = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ processed: Schema.Boolean }))
  )(
    yield* sql`SELECT processed FROM fidy_durable.cluster_messages WHERE entity_type = ${HostedTurns.type} AND kind = 0`
  );
});
const inference = (execute: (text: string) => Effect.Effect<void>): HostedInference["Service"] =>
  makeHostedInference<HostedTextContext, void>({
    countText: () => Effect.succeed(1),
    countTranscript: () => Effect.succeed(1),
    prepare: ({ projection }) => Effect.succeed(projection),
    execute: (request) => {
      const text =
        request.activeRequest._tag === "Present" ? request.activeRequest.text : "continuation";
      return execute(text).pipe(
        Effect.as({
          result: {
            text,
            toolCalls: [],
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          },
          continuation: undefined,
        })
      );
    },
    structured: { prepare: () => Effect.die("Unexpected Compaction in bounded Turn fixture") },
  });
const runtimeLayer = (input: {
  port: number;
  crypto: Crypto.Crypto;
  http: HttpClient.HttpClient;
  generate: (text: string) => Effect.Effect<void>;
  deliver: (text: string) => Effect.Effect<void>;
}): Layer.Layer<
  | AgentService
  | PersistedQueue.PersistedQueueFactory
  | Layer.Success<typeof PgLive>
  | Layer.Success<ReturnType<typeof authenticatedClusterHttp.layerSql>>,
  Layer.Error<typeof PgLive> | Layer.Error<ReturnType<typeof authenticatedClusterHttp.layerSql>>
> => {
  const agentRuntime = AgentService.layer.pipe(
    Layer.provideMerge(
      authenticatedClusterHttp.layerSql(token, {
        runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", input.port)),
        runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", input.port)),
        availableShardGroups: ["default"],
        assignedShardGroups: ["default"],
        shardsPerGroup: testShardCount,
        entityMessagePollInterval: 50,
        sendRetryInterval: 50,
        shardLockDisableAdvisory: true,
        shardLockRefreshInterval: 500,
        entityTerminationTimeout: 1000,
        shardLockExpiration: 3000,
        runnerHealthCheckInterval: 250,
        refreshAssignmentsInterval: 100,
      })
    ),
    Layer.provide(
      WhatsAppReplyDeliveryLive.pipe(
        Layer.provide(
          Layer.succeed(KapsoClient, {
            sendText: (request) =>
              Effect.gen(function* () {
                yield* input.deliver(request.text);
                return {
                  messageEvidence: {
                    channel: "whatsapp" as const,
                    provider: "kapso",
                    providerMessageId: WhatsAppProviderMessageId.make(
                      yield* input.crypto.randomUUIDv4.pipe(Effect.orDie)
                    ),
                  },
                  sentAt: yield* DateTime.now,
                  responseStatus: TelemetryHttpStatus.make(200),
                };
              }),
          })
        )
      )
    ),
    Layer.provide(Layer.succeed(HostedInference, inference(input.generate))),
    Layer.provide(
      Layer.succeed(ImmediateDelivery, { deliver: (reply) => input.deliver(reply.text) })
    ),
    Layer.provide(SqlWhatsAppQueueLive),
    Layer.provide(Layer.succeed(Crypto.Crypto, input.crypto)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, input.http)),
    Layer.provide(TelemetryDisabled),
    Layer.provideMerge(PgLive),
    Layer.provide(TestPublicNamespace)
  );
  return SqlWhatsAppQueueLive.pipe(Layer.provideMerge(agentRuntime));
};
/** Waits for the initial rebalance, so a serialization test does not accidentally test owner shutdown. */
const waitForAssignments = Effect.fn(function* (
  runners: ReadonlyArray<{ readonly hasShardId: (id: ShardId.ShardId) => boolean }>
) {
  const shards = Array.from({ length: testShardCount }, (_, index) =>
    ShardId.make("default", index + 1)
  );
  return yield* Effect.sync(
    () =>
      runners.every((runner) => shards.some(runner.hasShardId)) &&
      shards.every((shard) => runners.filter((runner) => runner.hasShardId(shard)).length === 1)
  ).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("20 millis") }),
    Effect.timeout("10 seconds")
  );
});

const disposeRuntimes = (
  runtimes: ReadonlyArray<{ dispose: () => Promise<void> }>
): Effect.Effect<void> =>
  Effect.promise(() => Promise.all(runtimes.map((runtime) => runtime.dispose()))).pipe(
    Effect.asVoid
  );

/**
 * Waits until an operation reaches the named test barrier. A caller that finishes first means the
 * scenario never blocked, which is a broken test rather than a passing one.
 */
const awaitBarrier = <A, E, Barrier>(
  label: string,
  barrier: Deferred.Deferred<Barrier>,
  caller: Fiber.Fiber<A, E>
): Effect.Effect<Barrier, E> =>
  Effect.raceFirst(
    Deferred.await(barrier),
    Fiber.join(caller).pipe(Effect.andThen(Effect.die(`Request completed before ${label}`)))
  );

const handle = (
  userId: UserId,
  text: string
): Effect.Effect<AgentReply, AgentTurnError, AgentService> =>
  Effect.flatMap(AgentService, (agent) =>
    agent.handleMessage(userId, InboundMessage.make({ text: TranscriptText.make(text) }))
  );
const reset = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM transcript_entries WHERE user_id IN (${defaultUserId}, ${otherUserId})`;
  yield* sql`DELETE FROM conversation_turns WHERE user_id IN (${defaultUserId}, ${otherUserId})`;
  yield* sql`DELETE FROM hosted_agent_sessions WHERE user_id IN (${defaultUserId}, ${otherUserId})`;
  yield* seedConsentedPatIdentity({
    userId: otherUserId,
    bearer: TokenBearer.make("fin_clst0465_0123456789abcdefghijklmnopqrstuvwxyzABCD"),
  });
});
const admit = Effect.fn(function* (text: string) {
  const now = yield* DateTime.now;
  const message = TranscriptText.make(text);
  return yield* enqueueWhatsAppTurn({
    admission: {
      _tag: "AuthorizedTurn",
      userId: defaultUserId,
      inboundMessage: { text: message },
    },
    event: {
      messageEvidence: {
        channel: "whatsapp",
        provider: "kapso",
        providerMessageId: WhatsAppProviderMessageId.make(`wamid.${text}`),
      },
      caller: testWhatsAppCaller(defaultWhatsAppPhone),
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("46500001"),
      occurredAt: now,
      receivedAt: now,
      content: { _tag: "Text", text: message },
    },
    deliveryKey: WhatsAppDeliveryKey.make("465-delivery"),
    propagation: Option.none(),
  });
});
const enqueue = Effect.fn(function* (text: string) {
  yield* admit(text);
  const sql = yield* MigrationSqlClient;
  const [row] = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ id: WhatsAppInboundJobId }))
  )(
    yield* sql`SELECT job.id FROM whatsapp_inbound_jobs AS job
      JOIN whatsapp_message_evidence AS evidence ON evidence.id = job.message_evidence_id
      WHERE evidence.provider_message_id = ${`wamid.${text}`}`
  );
  if (row === undefined) return yield* Effect.die("accepted WhatsApp job was not retained");
  return WhatsAppInboundWork.make({
    version: 1,
    userId: defaultUserId,
    inboundJobId: row.id,
  });
});
const inboundState = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        assigned: Schema.Boolean,
        terminalOutcome: Schema.NullOr(Schema.String),
      })
    )
  )(
    yield* sql`SELECT turn_id IS NOT NULL AS assigned, terminal_outcome AS "terminalOutcome"
      FROM whatsapp_inbound_jobs WHERE user_id = ${defaultUserId}`
  );
});

const states = Effect.fn(function* (userId: UserId) {
  const sql = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(TurnRows)(
    yield* sql`SELECT state FROM conversation_turns
    WHERE user_id = ${userId} ORDER BY started_at, id`
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "45 seconds" })(
  "SQL hosted User entities",
  (it) => {
    it.effect("rolls back accepted evidence and durable publication together", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seedDevelopmentIdentity(defaultPatBearer);
        yield* truncateWhatsAppChannel;
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            admit("rollback-publication").pipe(Effect.andThen(Effect.fail("rollback")))
          )
          .pipe(Effect.ignore);
        const admin = yield* MigrationSqlClient;
        expect(
          yield* admin`SELECT provider_message_id FROM whatsapp_message_evidence
            WHERE provider_message_id = 'wamid.rollback-publication'`
        ).toEqual([]);
        expect(yield* admin`SELECT id FROM whatsapp_inbound_jobs`).toEqual([]);
        expect(
          yield* admin`SELECT id FROM fidy_durable.fidy_queue
            WHERE queue_name = 'whatsapp-inbound-turn'`
        ).toEqual([]);
      })
    );

    it.effect(
      "serializes one User through model and delivery while another User advances across two runtimes",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const events = yield* Ref.make<ReadonlyArray<string>>([]);
          const modelEntered = yield* Deferred.make<void>();
          const modelRelease = yield* Deferred.make<void>();
          const deliveryEntered = yield* Deferred.make<void>();
          const deliveryRelease = yield* Deferred.make<void>();
          const generate = (text: string): Effect.Effect<void> =>
            Ref.update(events, (items) => [...items, `model:${text}`]).pipe(
              Effect.andThen(
                text === "held"
                  ? Deferred.succeed(modelEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(modelRelease))
                    )
                  : Effect.void
              )
            );
          const deliver = (text: string): Effect.Effect<void> =>
            Ref.update(events, (items) => [...items, `delivery:${text}`]).pipe(
              Effect.andThen(
                text === "held"
                  ? Deferred.succeed(deliveryEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(deliveryRelease))
                    )
                  : Effect.void
              )
            );
          const firstRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24651, generate, deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24652, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([firstRuntime, secondRuntime]));
          yield* Effect.promise(() => firstRuntime.runPromise(Effect.void));
          yield* Effect.promise(() => secondRuntime.runPromise(Effect.void));
          yield* waitForAssignments(
            yield* Effect.promise(() =>
              Promise.all([
                firstRuntime.runPromise(Sharding.Sharding),
                secondRuntime.runPromise(Sharding.Sharding),
              ])
            )
          );
          const first = firstRuntime.runFork(handle(defaultUserId, "held"));
          yield* awaitBarrier("model barrier", modelEntered, first);
          const blockedAt = yield* DateTime.now;
          const admin = yield* MigrationSqlClient;
          const backends = yield* Effect.promise(() =>
            Promise.all([firstRuntime.runPromise(backendPid), secondRuntime.runPromise(backendPid)])
          );
          // Losing pooled SQL connections must not release ownership while provider work is still live.
          for (const rows of backends) {
            for (const { pid } of rows) yield* admin`SELECT pg_terminate_backend(${pid}, 1000)`;
          }
          // Drain the killed idle sockets before admitting unrelated work. An in-flight SQL
          // operation may fail on connection loss; the held provider operation must retain ownership.
          const reconnected = backendPid.pipe(
            Effect.retry({ times: 10, schedule: Schedule.spaced("20 millis") })
          );
          yield* Effect.promise(() =>
            Promise.all([
              firstRuntime.runPromise(reconnected),
              secondRuntime.runPromise(reconnected),
            ])
          );
          const next = secondRuntime.runFork(handle(defaultUserId, "next"));
          yield* Fiber.join(secondRuntime.runFork(handle(otherUserId, "parallel-model")));
          expect(yield* Ref.get(events)).not.toContain("model:next");
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
      AND state = 'idle in transaction' AND xact_start < ${blockedAt}`
          ).toEqual([]);
          yield* Deferred.succeed(modelRelease, undefined);
          yield* Deferred.await(deliveryEntered);
          yield* Fiber.interrupt(first);
          yield* Fiber.join(secondRuntime.runFork(handle(otherUserId, "parallel-delivery")));
          expect(yield* Ref.get(events)).not.toContain("model:next");
          yield* Deferred.succeed(deliveryRelease, undefined);
          yield* Fiber.join(next);
          expect(yield* states(defaultUserId)).toEqual([
            { state: "Completed" },
            { state: "Completed" },
          ]);
          expect(yield* states(otherUserId)).toEqual([
            { state: "Completed" },
            { state: "Completed" },
          ]);
          expect((yield* Ref.get(events)).filter((event) => event === "model:held")).toHaveLength(
            1
          );
        })
    );

    it.effect(
      "replacement recovers an admitted Turn without another message, inference, or delivery",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const owner = yield* Deferred.make<number>();
          const calls = yield* Ref.make(0);
          const sends = yield* Ref.make(0);
          const generate =
            (port: number): (() => Effect.Effect<void>) =>
            () =>
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(owner, port)),
                Effect.andThen(Effect.never)
              );
          const deliver = (): Effect.Effect<void> => Ref.update(sends, (count) => count + 1);
          const firstRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24653, generate: generate(24653), deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24654, generate: generate(24654), deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([firstRuntime, secondRuntime]));
          yield* Effect.promise(() => firstRuntime.runPromise(Effect.void));
          yield* Effect.promise(() => secondRuntime.runPromise(Effect.void));
          yield* waitForAssignments(
            yield* Effect.promise(() =>
              Promise.all([
                firstRuntime.runPromise(Sharding.Sharding),
                secondRuntime.runPromise(Sharding.Sharding),
              ])
            )
          );
          const first = firstRuntime.runFork(handle(defaultUserId, "abandoned"));
          const running = yield* awaitBarrier("owner barrier", owner, first);
          expect(yield* states(defaultUserId)).toEqual([{ state: "Pending" }]);
          yield* Effect.promise(() => (running === 24653 ? firstRuntime : secondRuntime).dispose());
          const recovered = yield* states(defaultUserId).pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.state === "Interrupted",
              schedule: Schedule.spaced("50 millis"),
            }),
            Effect.timeout("20 seconds")
          );
          expect(recovered).toEqual([{ state: "Interrupted" }]);
          expect(yield* Ref.get(calls)).toBe(1);
          expect(yield* Ref.get(sends)).toBe(0);
        })
    );

    it.effect(
      "rejects a substituted User at the durable WhatsApp handoff without publishing work",
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* seedDevelopmentIdentity(defaultPatBearer);
          yield* truncateWhatsAppChannel;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const calls = yield* Ref.make(0);
          const sends = yield* Ref.make(0);
          const runtime = ManagedRuntime.make(
            runtimeLayer({
              crypto,
              http,
              port: 24659,
              generate: () => Ref.update(calls, (count) => count + 1),
              deliver: () => Ref.update(sends, (count) => count + 1),
            })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
          const agent = yield* Effect.promise(() => runtime.runPromise(AgentService));
          yield* waitForAssignments([
            yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
          ]);
          const work = yield* enqueue("owned-whatsapp-input");
          const sql = yield* MigrationSqlClient;
          const before =
            yield* sql`SELECT * FROM whatsapp_inbound_jobs WHERE id = ${work.inboundJobId}`;
          yield* Effect.promise(() =>
            runtime.runPromise(agent.handleWhatsAppWork({ ...work, userId: otherUserId }))
          );
          expect(
            yield* sql`SELECT * FROM whatsapp_inbound_jobs WHERE id = ${work.inboundJobId}`
          ).toEqual(before);
          expect(
            yield* sql`SELECT request_id FROM fidy_durable.cluster_messages
              WHERE entity_type = ${HostedTurns.type}
              AND payload::text LIKE ${`%${work.inboundJobId}%`}`
          ).toEqual([]);
          expect(yield* states(defaultUserId)).toEqual([]);
          expect(yield* states(otherUserId)).toEqual([]);
          expect(yield* Ref.get(calls)).toBe(0);
          expect(yield* Ref.get(sends)).toBe(0);

          yield* Effect.promise(() => runtime.runPromise(agent.handleWhatsAppWork(work)));
          expect(yield* Ref.get(calls)).toBe(1);
          expect(yield* Ref.get(sends)).toBe(1);
        })
    );

    it.effect(
      "rejects mismatched entity addresses and never replays terminal or missing work",
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* seedDevelopmentIdentity(defaultPatBearer);
          yield* truncateWhatsAppChannel;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const calls = yield* Ref.make(0);
          const generate = (): Effect.Effect<void> => Ref.update(calls, (count) => count + 1);
          const deliver = (): Effect.Effect<void> => Effect.void;
          const runtime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24660, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
          const client = yield* Effect.promise(() => runtime.runPromise(HostedTurns.client));
          yield* waitForAssignments([
            yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
          ]);
          const turnId = TranscriptTurnId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
          const inboundJobId = WhatsAppInboundJobId.make(
            yield* crypto.randomUUIDv4.pipe(Effect.orDie)
          );
          const request = {
            userId: defaultUserId,
            turnId,
            limits: yield* CurrentAgentLimits,
            message: InboundMessage.make({ text: TranscriptText.make("wire-identity") }),
            authorityRoot: "no-verified-whatsapp-authority" as const,
          };
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(client(otherUserId).Handle(request).pipe(Effect.flip))
            )
          ).toBe("UnknownUser");
          yield* Effect.promise(() =>
            runtime.runPromise(client(otherUserId).Recover({ userId: defaultUserId, turnId }))
          );
          yield* Effect.promise(() =>
            runtime.runPromise(
              client(otherUserId).ProcessWhatsApp({
                version: 1,
                userId: defaultUserId,
                inboundJobId,
              })
            )
          );
          yield* Effect.promise(() =>
            runtime.runPromise(
              client(defaultUserId).ProcessWhatsApp({
                version: 1,
                userId: defaultUserId,
                inboundJobId,
              })
            )
          );
          expect(yield* Ref.get(calls)).toBe(0);
          expect(yield* states(defaultUserId)).toEqual([]);
          yield* Effect.promise(() => runtime.runPromise(client(defaultUserId).Handle(request)));
          expect(
            yield* Effect.promise(() =>
              runtime.runPromise(client(defaultUserId).Handle(request).pipe(Effect.flip))
            )
          ).toBe("HostedTurnAlreadyHandled");
          yield* pruneCompletedHostedTurnMessages(DateTime.add(yield* DateTime.now, { days: 2 }));
          // The same durable identity must remain harmless after the transport cache is gone.
          yield* Effect.promise(() =>
            runtime.runPromise(
              client(defaultUserId).ProcessWhatsApp({
                version: 1,
                userId: defaultUserId,
                inboundJobId,
              })
            )
          );
          expect(yield* Ref.get(calls)).toBe(1);
          expect(yield* states(defaultUserId)).toEqual([{ state: "Completed" }]);
          expect(yield* states(otherUserId)).toEqual([]);
        })
    );

    it.effect(
      "the composed channel worker polls, hands off, maintains retention, and shuts down",
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* seedDevelopmentIdentity(defaultPatBearer);
          yield* truncateWhatsAppChannel;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const calls = yield* Ref.make(0);
          const sends = yield* Ref.make(0);
          const generate = (): Effect.Effect<void> => Ref.update(calls, (count) => count + 1);
          const deliver = (): Effect.Effect<void> => Ref.update(sends, (count) => count + 1);
          const runtimes = [
            ManagedRuntime.make(runtimeLayer({ crypto, http, port: 24661, generate, deliver })),
            ManagedRuntime.make(runtimeLayer({ crypto, http, port: 24662, generate, deliver })),
          ] as const;
          yield* Effect.addFinalizer(() => disposeRuntimes(runtimes));
          yield* Effect.promise(() => runtimes[0].runPromise(Effect.void));
          yield* Effect.promise(() => runtimes[1].runPromise(Effect.void));
          yield* waitForAssignments(
            yield* Effect.promise(() =>
              Promise.all([
                runtimes[0].runPromise(Sharding.Sharding),
                runtimes[1].runPromise(Sharding.Sharding),
              ])
            )
          );
          const workerLayer = Layer.build(WhatsAppWorkerLive).pipe(
            Effect.andThen(Effect.never),
            Effect.scoped,
            Effect.provide(yield* Layer.build(TelemetryDisabled)),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(KapsoClient, {
              sendText: () => Effect.die("Unexpected disclosure"),
            })
          );
          const workers = runtimes.map((runtime) => runtime.runFork(workerLayer));
          yield* enqueue("composed-worker");
          yield* states(defaultUserId).pipe(
            Effect.repeat({
              until: (rows) => rows.length === 1 && rows[0]?.state === "Completed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds")
          );
          yield* Effect.forEach(workers, Fiber.interrupt, { discard: true });
          expect(yield* Ref.get(calls)).toBe(1);
          expect(yield* Ref.get(sends)).toBe(1);
        })
    );

    it.effect(
      "keeps a submitted WhatsApp burst beyond the old deadline and runs it after its caller disconnects",
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* seedDevelopmentIdentity(defaultPatBearer);
          yield* truncateWhatsAppChannel;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const generated = yield* Ref.make<ReadonlyArray<string>>([]);
          const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
          const generate = (text: string): Effect.Effect<void> =>
            Ref.update(generated, (items) => [...items, text]).pipe(
              Effect.andThen(
                text === "holds-user"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release))
                    )
                  : Effect.void
              )
            );
          const deliver = (text: string): Effect.Effect<void> =>
            Ref.update(delivered, (items) => [...items, text]);
          const firstRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24655, generate, deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24656, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([firstRuntime, secondRuntime]));
          yield* Effect.promise(() => firstRuntime.runPromise(Effect.void));
          yield* Effect.promise(() => secondRuntime.runPromise(Effect.void));
          yield* waitForAssignments(
            yield* Effect.promise(() =>
              Promise.all([
                firstRuntime.runPromise(Sharding.Sharding),
                secondRuntime.runPromise(Sharding.Sharding),
              ])
            )
          );
          const first = firstRuntime.runFork(handle(defaultUserId, "holds-user"));
          yield* awaitBarrier("model barrier", entered, first);
          yield* enqueue("queued-whatsapp");
          yield* Effect.sleep("2100 millis");
          expect(yield* inboundState).toEqual([{ assigned: false, terminalOutcome: null }]);
          expect(yield* Ref.get(generated)).toEqual(["holds-user"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          const replacement = firstRuntime.runFork(processNextWhatsAppTurn());
          yield* inboundState.pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.terminalOutcome === "delivered",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds")
          );
          yield* Fiber.interrupt(replacement);
          expect(yield* Ref.get(generated)).toEqual(["holds-user", "queued-whatsapp"]);
          expect(yield* Ref.get(delivered)).toEqual(["holds-user", "queued-whatsapp"]);
          expect(yield* states(defaultUserId)).toEqual([
            { state: "Completed" },
            { state: "Completed" },
          ]);
          const sql = yield* MigrationSqlClient;
          const messages =
            yield* sql`SELECT payload, headers FROM fidy_durable.cluster_messages WHERE entity_type = ${HostedTurns.type}`;
          const retained = yield* Schema.encodeEffect(UnknownJsonString)(messages);
          expect(retained).not.toContain("queued-whatsapp");
          expect(retained).not.toContain("holds-user");
          expect(
            yield* sql`SELECT content FROM whatsapp_inbound_jobs WHERE user_id = ${defaultUserId}`
          ).toEqual([{ content: null }]);
          const completed = yield* mailbox.pipe(
            Effect.repeat({
              until: (rows) => rows.every(({ processed }) => processed),
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds")
          );
          expect(completed.length).toBeGreaterThan(0);
          yield* pruneCompletedHostedTurnMessages(yield* DateTime.now);
          expect(yield* mailbox).toEqual(completed);
          yield* pruneCompletedHostedTurnMessages(DateTime.add(yield* DateTime.now, { days: 2 }));
          expect(yield* mailbox).toEqual([]);
        })
    );

    it.effect("runs an immediate Handle to completion after its caller disconnects", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seedDevelopmentIdentity(defaultPatBearer);
        const crypto = yield* Crypto.Crypto;
        const http = yield* HttpClient.HttpClient;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const calls = yield* Ref.make(0);
        const sends = yield* Ref.make(0);
        const generate = (text: string): Effect.Effect<void> =>
          Ref.update(calls, (count) => count + 1).pipe(
            Effect.andThen(
              text === "caller-disconnect"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void
            )
          );
        const deliver = (): Effect.Effect<void> => Ref.update(sends, (count) => count + 1);
        const runtime = ManagedRuntime.make(
          runtimeLayer({ crypto, http, port: 24663, generate, deliver })
        );
        yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
        const client = yield* Effect.promise(() => runtime.runPromise(HostedTurns.client));
        yield* waitForAssignments([
          yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
        ]);
        const request = {
          userId: defaultUserId,
          turnId: TranscriptTurnId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
          limits: yield* CurrentAgentLimits,
          message: InboundMessage.make({ text: TranscriptText.make("caller-disconnect") }),
          authorityRoot: "no-verified-whatsapp-authority" as const,
        };
        const caller = runtime.runFork(client(defaultUserId).Handle(request));
        yield* awaitBarrier("model barrier", entered, caller);
        expect(yield* states(defaultUserId)).toEqual([{ state: "Pending" }]);
        // The client-annotated operation must outlive its caller and finish the admitted Turn.
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(release, undefined);
        const completed = yield* states(defaultUserId).pipe(
          Effect.repeat({
            until: (rows) => rows[0]?.state === "Completed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds")
        );
        expect(completed).toEqual([{ state: "Completed" }]);
        expect(yield* Ref.get(calls)).toBe(1);
        expect(yield* Ref.get(sends)).toBe(1);
      })
    );

    it.effect("keeps a persisted ProcessWhatsApp running after its caller disconnects", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seedDevelopmentIdentity(defaultPatBearer);
        yield* truncateWhatsAppChannel;
        const crypto = yield* Crypto.Crypto;
        const http = yield* HttpClient.HttpClient;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const generated = yield* Ref.make<ReadonlyArray<string>>([]);
        const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
        const generate = (text: string): Effect.Effect<void> =>
          Ref.update(generated, (items) => [...items, text]).pipe(
            Effect.andThen(
              text === "persisted-disconnect"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void
            )
          );
        const deliver = (text: string): Effect.Effect<void> =>
          Ref.update(delivered, (items) => [...items, text]);
        const runtime = ManagedRuntime.make(
          runtimeLayer({ crypto, http, port: 24664, generate, deliver })
        );
        yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
        const client = yield* Effect.promise(() => runtime.runPromise(HostedTurns.client));
        yield* waitForAssignments([
          yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
        ]);
        const work = yield* enqueue("persisted-disconnect");
        const caller = runtime.runFork(client(defaultUserId).ProcessWhatsApp(work));
        yield* awaitBarrier("model barrier", entered, caller);
        // A durable client-annotated operation settles its accepted inbound work exactly once
        // even when the caller that submitted it is gone.
        yield* Fiber.interrupt(caller);
        // Give a forwarded interrupt time to arrive while the handler is still parked. Without
        // the client annotation the durable run would be cancelled here instead of settling.
        yield* Effect.sleep("1 second");
        yield* Deferred.succeed(release, undefined);
        const settled = yield* inboundState.pipe(
          Effect.repeat({
            until: (rows) => rows[0]?.terminalOutcome === "delivered",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds")
        );
        expect(settled).toEqual([{ assigned: true, terminalOutcome: "delivered" }]);
        expect(yield* Ref.get(generated)).toEqual(["persisted-disconnect"]);
        expect(yield* Ref.get(delivered)).toEqual(["persisted-disconnect"]);
        expect(yield* states(defaultUserId)).toEqual([{ state: "Completed" }]);
        // Replaying the same durable identity after the disconnect must not repeat effects.
        yield* Effect.promise(() =>
          runtime.runPromise(client(defaultUserId).ProcessWhatsApp(work))
        );
        expect(yield* Ref.get(generated)).toEqual(["persisted-disconnect"]);
        expect(yield* Ref.get(delivered)).toEqual(["persisted-disconnect"]);
      })
    );

    it.effect(
      "replacement settles an ambiguous WhatsApp send without repeating inference or delivery",
      () =>
        Effect.gen(function* () {
          yield* reset;
          yield* seedDevelopmentIdentity(defaultPatBearer);
          yield* truncateWhatsAppChannel;
          const crypto = yield* Crypto.Crypto;
          const http = yield* HttpClient.HttpClient;
          const owner = yield* Deferred.make<number>();
          const calls = yield* Ref.make(0);
          const sends = yield* Ref.make(0);
          const generate = (): Effect.Effect<void> => Ref.update(calls, (count) => count + 1);
          const deliver =
            (port: number): (() => Effect.Effect<void>) =>
            () =>
              Ref.update(sends, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(owner, port)),
                Effect.andThen(Effect.never)
              );
          const firstRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24657, generate, deliver: deliver(24657) })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 24658, generate, deliver: deliver(24658) })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([firstRuntime, secondRuntime]));
          yield* Effect.promise(() => firstRuntime.runPromise(Effect.void));
          yield* Effect.promise(() => secondRuntime.runPromise(Effect.void));
          yield* waitForAssignments(
            yield* Effect.promise(() =>
              Promise.all([
                firstRuntime.runPromise(Sharding.Sharding),
                secondRuntime.runPromise(Sharding.Sharding),
              ])
            )
          );
          yield* enqueue("ambiguous-whatsapp");
          const first = firstRuntime.runFork(processNextWhatsAppTurn());
          const running = yield* awaitBarrier("delivery barrier", owner, first);
          expect(yield* states(defaultUserId)).toEqual([{ state: "Pending" }]);
          yield* Effect.promise(() => (running === 24657 ? firstRuntime : secondRuntime).dispose());
          const replacementRuntime = running === 24657 ? secondRuntime : firstRuntime;
          const replacement = replacementRuntime.runFork(processNextWhatsAppTurn());
          const recovered = yield* inboundState.pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.terminalOutcome === "ambiguous_crash",
              schedule: Schedule.spaced("50 millis"),
            }),
            Effect.timeout("20 seconds")
          );
          expect(recovered).toEqual([{ assigned: true, terminalOutcome: "ambiguous_crash" }]);
          yield* Fiber.interrupt(replacement);
          expect(yield* states(defaultUserId)).toEqual([{ state: "Interrupted" }]);
          expect(yield* Ref.get(calls)).toBe(1);
          expect(yield* Ref.get(sends)).toBe(1);
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT content FROM whatsapp_inbound_jobs WHERE user_id = ${defaultUserId}`
          ).toEqual([{ content: null }]);
        })
    );
  }
);
