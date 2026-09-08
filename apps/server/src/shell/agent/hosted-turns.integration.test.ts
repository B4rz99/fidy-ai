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
  Ref,
  Schedule,
  Schema,
} from "effect";
import { ClusterSchema, Entity, RunnerAddress, ShardId, Sharding } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
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
  AgentLimits,
  AgentReply,
  AgentService,
  type AgentTurnError,
  CurrentAgentLimits,
  InboundMessage,
} from "./agent-service";
import { HostedInference, type HostedTextContext, makeHostedInference } from "./hosted-inference";
import { ImmediateDelivery } from "./immediate-delivery";
import { WhatsAppReplyDeliveryLive } from "./whatsapp-delivery";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppDeliveryKey,
  WhatsAppProviderMessageId,
} from "~/shell/channels/whatsapp/model";
import {
  WhatsAppClaimId,
  claimWhatsAppTurn,
  enqueueWhatsAppTurn,
} from "~/shell/channels/whatsapp/repo";
import { WhatsAppWorkerLive, processNextWhatsAppTurn } from "~/shell/channels/whatsapp/worker";
import { truncateWhatsAppChannel } from "~/shell/channels/whatsapp/fixtures";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import { testWhatsAppCaller } from "~/shell/testing/whatsapp-caller";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";

/** Independent wire client: exercise malformed addresses and replay without exposing lifecycle APIs. */
const HostedWire = Entity.make("HostedTurns", [
  Rpc.make("Handle", {
    payload: {
      userId: UserId,
      turnId: TranscriptTurnId,
      message: InboundMessage,
      limits: AgentLimits,
      authorityRoot: Schema.Literals(["no-verified-whatsapp-authority", "verified-whatsapp"]),
    },
    success: AgentReply,
    error: Schema.String,
  }),
  Rpc.make("Recover", {
    payload: { userId: UserId, turnId: TranscriptTurnId },
    primaryKey: ({ turnId }) => turnId,
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("ProcessWhatsApp", {
    payload: { version: Schema.Literal(1), userId: UserId, claimId: WhatsAppClaimId },
    primaryKey: ({ claimId }) => claimId,
  }).annotate(ClusterSchema.Persisted, true),
]);

const otherUserId = UserId.make("f1d1a000-0000-4000-8000-000000000465");
const token = "a".repeat(64);
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
    yield* sql`SELECT processed FROM fidy_durable.cluster_messages WHERE entity_type = 'HostedTurns' AND kind = 0`
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
  | Layer.Success<typeof PgLive>
  | Layer.Success<ReturnType<typeof authenticatedClusterHttp.layerSql>>,
  Layer.Error<typeof PgLive> | Layer.Error<ReturnType<typeof authenticatedClusterHttp.layerSql>>
> =>
  AgentService.layer.pipe(
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
    Layer.provide(PersistedQueue.layer.pipe(Layer.provide(PersistedQueue.layerStoreMemory))),
    Layer.provide(Layer.succeed(Crypto.Crypto, input.crypto)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, input.http)),
    Layer.provide(TelemetryDisabled),
    Layer.provideMerge(PgLive),
    Layer.provide(TestPublicNamespace)
  );
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
const enqueue = Effect.fn(function* (text: string) {
  const now = yield* DateTime.now;
  const message = TranscriptText.make(text);
  yield* enqueueWhatsAppTurn({
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
  return DateTime.add(now, { seconds: 3 });
});
const claimState = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        status: Schema.String,
        noDeadline: Schema.Boolean,
        safeReason: Schema.NullOr(Schema.String),
      })
    )
  )(
    yield* sql`
    SELECT status, claim_expires_at IS NULL AS "noDeadline", safe_reason AS "safeReason"
    FROM whatsapp_turn_claims WHERE user_id = ${defaultUserId}`
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
            runtimeLayer({ crypto, http, port: 44651, generate, deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44652, generate, deliver })
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
          yield* Effect.raceFirst(
            Deferred.await(modelEntered),
            Fiber.join(first).pipe(
              Effect.andThen(Effect.die("Request completed before model barrier"))
            )
          );
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
            runtimeLayer({ crypto, http, port: 44653, generate: generate(44653), deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44654, generate: generate(44654), deliver })
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
          const running = yield* Effect.raceFirst(
            Deferred.await(owner),
            Fiber.join(first).pipe(
              Effect.andThen(Effect.die("Request completed before owner barrier"))
            )
          );
          expect(yield* states(defaultUserId)).toEqual([{ state: "Pending" }]);
          yield* Effect.promise(() => (running === 44653 ? firstRuntime : secondRuntime).dispose());
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
          const generate = (): Effect.Effect<void> => Ref.update(calls, (count) => count + 1);
          const deliver = (): Effect.Effect<void> => Ref.update(sends, (count) => count + 1);
          const runtime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44659, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
          const agent = yield* Effect.promise(() => runtime.runPromise(AgentService));
          yield* waitForAssignments([
            yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
          ]);
          const due = yield* enqueue("owned-whatsapp-input");
          const claim = Option.getOrThrow(yield* claimWhatsAppTurn(due));
          const sql = yield* MigrationSqlClient;
          const claimRows = sql`SELECT * FROM whatsapp_turn_claims WHERE id = ${claim.claimId}`;
          const inputRows = sql`SELECT * FROM whatsapp_inbound_jobs WHERE user_id = ${defaultUserId}`;
          const beforeClaim = yield* claimRows;
          const beforeInput = yield* inputRows;
          yield* Effect.promise(() =>
            runtime.runPromise(agent.handleWhatsAppClaim({ ...claim, userId: otherUserId }, due))
          );
          expect(yield* claimRows).toEqual(beforeClaim);
          expect(yield* inputRows).toEqual(beforeInput);
          expect(
            yield* sql`SELECT request_id FROM fidy_durable.cluster_messages
          WHERE entity_type = 'HostedTurns' AND tag = 'ProcessWhatsApp'
          AND payload::text LIKE ${`%${claim.claimId}%`}`
          ).toEqual([]);
          expect(
            yield* sql`SELECT entry_id FROM transcript_entries
          WHERE user_id IN (${defaultUserId}, ${otherUserId})`
          ).toEqual([]);
          expect(yield* states(defaultUserId)).toEqual([]);
          expect(yield* states(otherUserId)).toEqual([]);
          expect(yield* Ref.get(calls)).toBe(0);
          expect(yield* Ref.get(sends)).toBe(0);
          // The invalid handoff neither consumed the claim nor occupied its durable identity.
          yield* Effect.promise(() => runtime.runPromise(agent.handleWhatsAppClaim(claim, due)));
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
            runtimeLayer({ crypto, http, port: 44660, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
          const client = yield* Effect.promise(() => runtime.runPromise(HostedWire.client));
          yield* waitForAssignments([
            yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
          ]);
          const turnId = TranscriptTurnId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
          const claimId = WhatsAppClaimId.make(turnId);
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
              client(otherUserId).ProcessWhatsApp({ version: 1, userId: defaultUserId, claimId })
            )
          );
          yield* Effect.promise(() =>
            runtime.runPromise(
              client(defaultUserId).ProcessWhatsApp({ version: 1, userId: defaultUserId, claimId })
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
              client(defaultUserId).ProcessWhatsApp({ version: 1, userId: defaultUserId, claimId })
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
          const runtime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44661, generate, deliver })
          );
          yield* Effect.addFinalizer(() => disposeRuntimes([runtime]));
          yield* Effect.promise(() => runtime.runPromise(Effect.void));
          yield* waitForAssignments([
            yield* Effect.promise(() => runtime.runPromise(Sharding.Sharding)),
          ]);
          const worker = runtime.runFork(
            Layer.build(WhatsAppWorkerLive).pipe(
              Effect.andThen(Effect.never),
              Effect.scoped,
              Effect.provide(yield* Layer.build(TelemetryDisabled)),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(KapsoClient, {
                sendText: () => Effect.die("Unexpected disclosure"),
              })
            )
          );
          yield* enqueue("composed-worker");
          yield* states(defaultUserId).pipe(
            Effect.repeat({
              until: (rows) => rows.length === 1 && rows[0]?.state === "Completed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds")
          );
          yield* Fiber.interrupt(worker);
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
            runtimeLayer({ crypto, http, port: 44655, generate, deliver })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44656, generate, deliver })
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
          yield* Effect.raceFirst(
            Deferred.await(entered),
            Fiber.join(first).pipe(Effect.andThen(Effect.die("Request completed before barrier")))
          );
          const due = yield* enqueue("queued-whatsapp");
          const waiter = secondRuntime.runFork(processNextWhatsAppTurn(due));
          yield* claimState.pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.status === "submitted",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds")
          );
          yield* Fiber.interrupt(waiter);
          expect(yield* claimWhatsAppTurn(DateTime.add(due, { hours: 1 }))).toEqual(Option.none());
          expect(yield* claimState).toEqual([
            { status: "submitted", noDeadline: true, safeReason: null },
          ]);
          yield* pruneCompletedHostedTurnMessages(DateTime.add(due, { days: 2 }));
          expect((yield* mailbox).some(({ processed }) => !processed)).toBe(true);
          expect(yield* Ref.get(generated)).toEqual(["holds-user"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* claimState.pipe(
            Effect.repeat({
              until: (rows) => rows.length === 0,
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds")
          );
          expect(yield* Ref.get(generated)).toEqual(["holds-user", "queued-whatsapp"]);
          expect(yield* Ref.get(delivered)).toEqual(["holds-user", "queued-whatsapp"]);
          expect(yield* states(defaultUserId)).toEqual([
            { state: "Completed" },
            { state: "Completed" },
          ]);
          const sql = yield* MigrationSqlClient;
          const messages =
            yield* sql`SELECT payload, headers FROM fidy_durable.cluster_messages WHERE entity_type = 'HostedTurns'`;
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
          yield* pruneCompletedHostedTurnMessages(DateTime.add(due, { days: 2 }));
          expect(yield* mailbox).toEqual([]);
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
            runtimeLayer({ crypto, http, port: 44657, generate, deliver: deliver(44657) })
          );
          const secondRuntime = ManagedRuntime.make(
            runtimeLayer({ crypto, http, port: 44658, generate, deliver: deliver(44658) })
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
          const due = yield* enqueue("ambiguous-whatsapp");
          const first = firstRuntime.runFork(processNextWhatsAppTurn(due));
          const running = yield* Effect.raceFirst(
            Deferred.await(owner),
            Fiber.join(first).pipe(
              Effect.andThen(Effect.die("Request completed before delivery barrier"))
            )
          );
          expect(yield* states(defaultUserId)).toEqual([{ state: "Pending" }]);
          yield* Effect.promise(() => (running === 44657 ? firstRuntime : secondRuntime).dispose());
          const recovered = yield* claimState.pipe(
            Effect.repeat({
              until: (rows) => rows[0]?.status === "failed",
              schedule: Schedule.spaced("50 millis"),
            }),
            Effect.timeout("20 seconds")
          );
          expect(recovered).toEqual([
            { status: "failed", noDeadline: true, safeReason: "ambiguous_crash" },
          ]);
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
