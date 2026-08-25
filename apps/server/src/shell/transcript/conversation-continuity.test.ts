import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import type { ConfigError } from "effect/Config";
import { TestClock } from "effect/testing";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { expectTypeOf } from "vitest";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { CompactedConversationOutput } from "~/core/transcript/compacted-conversation";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { ConversationCompactionTokenCount } from "~/core/transcript/compaction-policy";
import type { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import {
  AgentIteration,
  type AssistantTranscriptEntry,
  type CanonicalToolEvidence,
  type CanonicalToolOutcome,
  ToolCallId,
  TranscriptContentEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  type TurnContinuationEntry,
  type TurnFailureReason,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { projectTranscriptForModel } from "~/shell/agent/model-boundary";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import { appendConsentRecord } from "~/shell/consent/repo";
import { advisoryLockKey, withUserTurnLock } from "~/shell/db/advisory-lock";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId, seedOnboardingConsent } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  ConversationCompactionInference,
  ConversationCompactionInferenceError,
} from "./conversation-compaction-inference";
import {
  type ActiveTurnRequest,
  type AdmittedTurn,
  CompactionCommitObserver,
  ContinuityChanged,
  type ContinuityView,
  ConversationCompactionPolicy,
  ConversationContinuity,
  type ConversationContinuityService,
  type DeliveredAssistantContent,
  HostedAgentSessionConsentRequired,
  type PreparedTurnContext,
  type TurnContinuationContent,
} from "./conversation-continuity";

type ExpectedActiveTurnRequest = Pick<UserTranscriptEntry, "text">;
type WithoutContinuityMetadata<Entry> = Entry extends unknown
  ? Omit<Entry, "id" | "turnId" | "occurredAt">
  : never;
type ExpectedContinuationContent = WithoutContinuityMetadata<TurnContinuationEntry>;
type ExpectedAssistantContent = Pick<AssistantTranscriptEntry, "iteration" | "text">;
const encodePersistedTranscriptEntry = Schema.encodeSync(Schema.toCodecJson(TranscriptEntry));

expectTypeOf<ActiveTurnRequest>().toEqualTypeOf<ExpectedActiveTurnRequest>();
expectTypeOf<TurnContinuationContent>().toEqualTypeOf<ExpectedContinuationContent>();
expectTypeOf<DeliveredAssistantContent>().toEqualTypeOf<ExpectedAssistantContent>();
// The whole module surface is plain data in and plain data out: no capability, handle, or callback
// crosses it, so nothing a caller retains can carry a Turn's authority.
expectTypeOf<keyof ConversationContinuityService>().toEqualTypeOf<
  | "observe"
  | "admitSession"
  | "requireSession"
  | "prepareTurn"
  | "admitTurn"
  | "appendTurn"
  | "completeTurn"
  | "failTurn"
>();
expectTypeOf<AdmittedTurn>().toEqualTypeOf<
  Readonly<{ turnId: TranscriptTurnId; hostedAgentSessionId: HostedAgentSessionId }>
>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["admitSession"]>>
>().toEqualTypeOf<HostedAgentSessionConsentRequired>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["requireSession"]>>
>().toEqualTypeOf<HostedAgentSessionConsentRequired>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["prepareTurn"]>>
>().toEqualTypeOf<never>();
expectTypeOf<Effect.Error<ReturnType<ConversationContinuityService["admitTurn"]>>>().toEqualTypeOf<
  ContinuityChanged | HostedAgentSessionConsentRequired
>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["appendTurn"]>>
>().toEqualTypeOf<never>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["completeTurn"]>>
>().toEqualTypeOf<never>();
expectTypeOf<
  Effect.Error<ReturnType<ConversationContinuityService["failTurn"]>>
>().toEqualTypeOf<never>();

type CryptoRaceGate = {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

type CompactionCommitTag = "Committed" | "Stale";

type CompactionGate = {
  readonly entered: Deferred.Deferred<void>;
  readonly enteredAgain: Deferred.Deferred<void>;
  readonly enteredCount: Ref.Ref<number>;
  readonly commitResults: Ref.Ref<ReadonlyArray<CompactionCommitTag>>;
  readonly release: Deferred.Deferred<void>;
  readonly releaseOlder: Deferred.Deferred<void>;
  readonly releaseNewer: Deferred.Deferred<void>;
  readonly ordered: boolean;
  readonly afterGeneration: Option.Option<Effect.Effect<void>>;
};

class CompactionRaceControl extends Context.Service<
  CompactionRaceControl,
  {
    readonly arm: (
      afterGeneration?: Effect.Effect<void>,
      ordered?: boolean
    ) => Effect.Effect<CompactionGate>;
  }
>()("@fidy/server/shell/transcript/conversation-continuity.test/CompactionRaceControl") {}

class CryptoRaceControl extends Context.Service<
  CryptoRaceControl,
  { readonly arm: Effect.Effect<CryptoRaceGate> }
>()("@fidy/server/shell/transcript/conversation-continuity.test/CryptoRaceControl") {}

type FixedCompactionFailure = "failed" | "timed-out" | "malformed" | "oversized" | "success";

class CompactionFailureControl extends Context.Service<
  CompactionFailureControl,
  {
    readonly select: (failure: FixedCompactionFailure) => Effect.Effect<void>;
    readonly generationStarted: Deferred.Deferred<void>;
  }
>()("@fidy/server/shell/transcript/conversation-continuity.test/CompactionFailureControl") {}

const ControlledCrypto = Layer.effectContext(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const nextGate = yield* Ref.make(Option.none<CryptoRaceGate>());
    const arm = Effect.gen(function* () {
      const gate: CryptoRaceGate = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* Ref.set(nextGate, Option.some(gate));
      return gate;
    });
    const controlled: Crypto.Crypto = {
      ...crypto,
      get randomUUIDv7() {
        return Ref.getAndSet(nextGate, Option.none()).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => crypto.randomUUIDv7,
              onSome: (gate) =>
                Deferred.succeed(gate.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate.release)),
                  Effect.andThen(crypto.randomUUIDv7)
                ),
            })
          )
        );
      },
    };
    return Context.empty().pipe(
      Context.add(Crypto.Crypto, controlled),
      Context.add(CryptoRaceControl, { arm })
    );
  })
);

const ContinuityHarness = ConversationContinuity.layer.pipe(
  Layer.provideMerge(ControlledCrypto),
  Layer.provideMerge(ApiHarness)
);

const compactionLayer = (maximumTokens: number): typeof ContinuityHarness =>
  ConversationContinuity.layer.pipe(
    Layer.provide(
      Layer.succeed(ConversationCompactionInference, {
        countText: (text) => Effect.succeed(text.length),
        countTranscript: (entries) => Effect.succeed(entries.length),
        generate: () => Effect.succeed({ compactedConversation: "resumen fiel" }),
      })
    ),
    Layer.provide(
      Layer.succeed(ConversationCompactionPolicy, {
        triggerTokens: ConversationCompactionTokenCount.make(3),
        maximumTokens: ConversationCompactionTokenCount.make(maximumTokens),
      })
    ),
    Layer.provideMerge(ControlledCrypto),
    Layer.provideMerge(ApiHarness)
  );

const CompactionHarness = compactionLayer(100);
const OversizedCompactionHarness = compactionLayer(1);

const FixedFailureCompactionServices = Layer.effectContext(
  Effect.gen(function* () {
    const selected = yield* Ref.make<FixedCompactionFailure>("failed");
    const generationStarted = yield* Deferred.make<void>();
    return Context.empty().pipe(
      Context.add(CompactionFailureControl, {
        select: (failure) => Ref.set(selected, failure),
        generationStarted,
      }),
      Context.add(ConversationCompactionInference, {
        countTranscript: (entries) => Effect.succeed(entries.length),
        countText: (text) => Effect.succeed(text === "oversized" ? 101 : text.length),
        generate: () =>
          Ref.get(selected).pipe(
            Effect.flatMap((failure) => {
              switch (failure) {
                case "failed":
                  return Effect.fail(new ConversationCompactionInferenceError({ cause: failure }));
                case "timed-out":
                  return Deferred.succeed(generationStarted, undefined).pipe(
                    Effect.andThen(Effect.never)
                  );
                case "malformed":
                  return Schema.decodeUnknownEffect(CompactedConversationOutput)({
                    compactedConversation: 42,
                  }).pipe(
                    Effect.mapError((cause) => new ConversationCompactionInferenceError({ cause }))
                  );
                case "oversized":
                  return Effect.succeed({ compactedConversation: "oversized" });
                case "success":
                  return Effect.succeed({ compactedConversation: "recovered" });
                default:
                  return failure satisfies never;
              }
            })
          ),
      })
    );
  })
);

const FixedFailureCompactionHarness = ConversationContinuity.layer.pipe(
  Layer.provideMerge(FixedFailureCompactionServices),
  Layer.provide(
    Layer.succeed(ConversationCompactionPolicy, {
      triggerTokens: ConversationCompactionTokenCount.make(3),
      maximumTokens: ConversationCompactionTokenCount.make(100),
    })
  ),
  Layer.provideMerge(ControlledCrypto),
  Layer.provideMerge(ApiHarness)
);

const TimeoutCompactionHarness = Layer.merge(FixedFailureCompactionHarness, TestClock.layer());

const TokenScenarioCompactionHarness = ConversationContinuity.layer.pipe(
  Layer.provide(
    Layer.succeed(ConversationCompactionInference, {
      countText: (text) => Effect.succeed(text.length),
      countTranscript: (entries) =>
        Effect.succeed(
          entries.reduce((tokens, entry) => {
            if (entry._tag !== "UserTranscriptEntry") return tokens;
            if (entry.text.startsWith("large:")) return tokens + 2;
            if (entry.text.startsWith("token:")) return tokens + 1;
            return tokens;
          }, 0)
        ),
      generate: (prior, entries) =>
        Effect.succeed({
          compactedConversation: `${Option.getOrElse(prior, () => "initial")}|${entries
            .filter((entry): entry is UserTranscriptEntry => entry._tag === "UserTranscriptEntry")
            .map(({ text }) => text)
            .join(",")}`,
        }),
    })
  ),
  Layer.provide(
    Layer.succeed(ConversationCompactionPolicy, {
      triggerTokens: ConversationCompactionTokenCount.make(3),
      maximumTokens: ConversationCompactionTokenCount.make(10_000),
    })
  ),
  Layer.provideMerge(ControlledCrypto),
  Layer.provideMerge(ApiHarness)
);
const ControlledCompactionInference = Layer.effectContext(
  Effect.gen(function* () {
    const nextGate = yield* Ref.make(Option.none<CompactionGate>());
    const arm = (
      afterGeneration?: Effect.Effect<void>,
      ordered = false
    ): Effect.Effect<CompactionGate> =>
      Effect.gen(function* () {
        const gate: CompactionGate = {
          entered: yield* Deferred.make<void>(),
          enteredAgain: yield* Deferred.make<void>(),
          enteredCount: yield* Ref.make(0),
          commitResults: yield* Ref.make<ReadonlyArray<CompactionCommitTag>>([]),
          release: yield* Deferred.make<void>(),
          releaseOlder: yield* Deferred.make<void>(),
          releaseNewer: yield* Deferred.make<void>(),
          ordered,
          afterGeneration: Option.fromNullishOr(afterGeneration),
        };
        yield* Ref.set(nextGate, Option.some(gate));
        return gate;
      });
    const observeCompactionCommit = (tag: CompactionCommitTag): Effect.Effect<void> =>
      Ref.get(nextGate).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (gate) => Ref.update(gate.commitResults, (results) => [...results, tag]),
          })
        )
      );
    return Context.empty().pipe(
      Context.add(CompactionRaceControl, { arm }),
      Context.add(CompactionCommitObserver, observeCompactionCommit),
      Context.add(ConversationCompactionInference, {
        countText: (text: string): Effect.Effect<number> => Effect.succeed(text.length),
        countTranscript: (entries: ReadonlyArray<TranscriptEntry>): Effect.Effect<number> =>
          Effect.succeed(entries.length),
        generate: () =>
          Ref.get(nextGate).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed({ compactedConversation: "resumen fiel" }),
                onSome: (gate) =>
                  Effect.gen(function* () {
                    const entered = yield* Ref.updateAndGet(
                      gate.enteredCount,
                      (count) => count + 1
                    );
                    yield* Deferred.succeed(gate.entered, undefined);
                    if (entered >= 2) yield* Deferred.succeed(gate.enteredAgain, undefined);
                    let release = gate.release;
                    let compactedConversation = "resumen fiel";
                    if (gate.ordered) {
                      if (entered === 1) {
                        release = gate.releaseOlder;
                        compactedConversation = "older-compaction";
                      } else {
                        release = gate.releaseNewer;
                        compactedConversation = "newer-compaction";
                      }
                    }
                    yield* Deferred.await(release);
                    yield* Option.getOrElse(gate.afterGeneration, () => Effect.void);
                    return { compactedConversation };
                  }),
              })
            )
          ),
      })
    );
  })
);

const ConsentLockedCompactionHarness = ConversationContinuity.layer.pipe(
  Layer.provideMerge(ControlledCompactionInference),
  Layer.provide(
    Layer.succeed(ConversationCompactionPolicy, {
      triggerTokens: ConversationCompactionTokenCount.make(3),
      maximumTokens: ConversationCompactionTokenCount.make(100),
    })
  ),
  Layer.provideMerge(ControlledCrypto),
  Layer.provideMerge(ApiHarness),
  Layer.provideMerge(ControlledCompactionInference)
);
const ForgedActiveTurnRequest = Schema.declare(
  (input): input is ActiveTurnRequest => typeof input === "object" && input !== null
);
const ForgedContinuationContent = Schema.declare(
  (input): input is TurnContinuationContent => typeof input === "object" && input !== null
);
const ForgedAssistantContent = Schema.declare(
  (input): input is DeliveredAssistantContent => typeof input === "object" && input !== null
);
const ForgedTurnFailureReason = Schema.declare(
  (input): input is TurnFailureReason => typeof input === "string"
);

const activeRequest = (text: string): ActiveTurnRequest => ({
  text: TranscriptText.make(text),
});

const assistantContent = (text = "Claro", iteration = 1): DeliveredAssistantContent => ({
  iteration: AgentIteration.make(iteration),
  text: TranscriptText.make(text),
});

const operation = CanonicalOperationId.make("categories.listCategories");
const toolCallContent = (
  suffix = "default",
  input: CanonicalToolEvidence = { query: "exact" },
  iteration = 1
): TurnContinuationContent => ({
  _tag: "CanonicalToolCallEntry",
  iteration: AgentIteration.make(iteration),
  toolCallId: ToolCallId.make(`call-${suffix}`),
  operation,
  input,
});
const toolResultContent = (
  outcome: CanonicalToolOutcome,
  suffix = "default",
  iteration = 1
): TurnContinuationContent => ({
  _tag: "CanonicalToolResultEntry",
  iteration: AgentIteration.make(iteration),
  toolCallId: ToolCallId.make(`call-${suffix}`),
  operation,
  outcome,
});

const withoutMetadata = (entry: TranscriptEntry): unknown => {
  const { id: _id, turnId: _turnId, occurredAt: _occurredAt, ...content } = entry;
  return content;
};

const assertDefect = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
};

/** Recognizes the closed-session refusal, so an unrelated failure cannot satisfy the assertion. */
const hostedSessionClosed = (error: unknown): boolean =>
  error instanceof HostedAgentSessionConsentRequired;

const assertContentFreeDefect = (exit: Exit.Exit<unknown, unknown>, secret: string): void => {
  assertDefect(exit);
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret);
};

const resetDefaultContinuity = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM transcript_entries WHERE user_id = ${defaultUserId}`;
  yield* sql`DELETE FROM conversation_continuity WHERE user_id = ${defaultUserId}`;
  yield* sql`DELETE FROM hosted_agent_sessions WHERE user_id = ${defaultUserId}`;
  // Whether a session may carry work reads the User's whole Consent standing, not only the grant it
  // pinned, so every program starts from the seeded basis instead of decisions an earlier one left.
  yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${defaultUserId}`;
  yield* seedOnboardingConsent(defaultUserId).pipe(Effect.orDie);
});

const isolatedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000004b0");
const resetIsolatedUser = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM hosted_agent_sessions WHERE user_id = ${isolatedUserId}`;
  yield* sql`DELETE FROM consent_records WHERE subject_user_id = ${isolatedUserId}`;
  yield* sql`DELETE FROM users WHERE id = ${isolatedUserId}`;
  yield* sql`
    INSERT INTO users (
      id, service_market, locale, time_zone, created_at,
      paid_tier, trial_started_at, trial_ends_at
    ) VALUES (
      ${isolatedUserId}, 'CO', 'es-CO', 'America/Bogota',
      '2026-08-11T00:00:00Z', 'free',
      '2026-08-11T00:00:00Z', '2026-08-18T00:00:00Z'
    )
  `;
  yield* seedOnboardingConsent(isolatedUserId).pipe(Effect.orDie);
});

const assertGeneratedMetadata = (completed: ContinuityView): void => {
  expect(completed.turns[0]?._tag).toBe("Completed");
  const turn = Option.getOrThrow(Arr.head(completed.turns));
  const ids = completed.entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of completed.entries) {
    expect(Schema.is(TranscriptEntryId)(entry.id)).toBe(true);
    expect(entry.turnId).toBe(turn.id);
  }
  const times = completed.entries.map((entry) => entry.occurredAt.epochMilliseconds);
  expect(times).toEqual(times.toSorted((left, right) => left - right));
  expect(turn.startedAt).toEqual(Option.getOrThrow(Arr.head(completed.entries)).occurredAt);
  if (turn._tag === "Completed") {
    expect(turn.terminalAt).toEqual(Option.getOrThrow(Arr.last(completed.entries)).occurredAt);
  }
};

/**
 * Mirrors the hosted runtime's own preamble: one serialized User, one admitted Hosted Agent
 * Session, one rechecked session, one prepared snapshot. Composed from the public operations, so
 * nothing here is a capability the module handed out.
 */
type PreparedTurnInput = Readonly<{
  continuity: ConversationContinuityService;
  userId: UserId;
  request: ActiveTurnRequest;
}>;

const withPreparedTurn = <A, E, R>(
  { continuity, userId, request }: PreparedTurnInput,
  use: (prepared: PreparedTurnContext) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | HostedAgentSessionConsentRequired, R | SqlClient.SqlClient> =>
  withUserTurnLock(
    userId,
    Effect.flatMap(continuity.admitSession(userId), (hostedAgentSessionId) =>
      continuity
        .requireSession(userId, hostedAgentSessionId)
        .pipe(
          Effect.andThen(continuity.prepareTurn(userId, hostedAgentSessionId, request)),
          Effect.flatMap(use)
        )
    )
  );

/** The Turn operations one admission enables, each naming the durable Turn rather than holding it. */
type AdmittedTurnOperations = Readonly<{
  turnId: TranscriptTurnId;
  append: (entries: Arr.NonEmptyReadonlyArray<TurnContinuationContent>) => Effect.Effect<void>;
  complete: (assistant: DeliveredAssistantContent) => Effect.Effect<void>;
  fail: (reason: TurnFailureReason) => Effect.Effect<void>;
}>;

const admitTurn = (
  continuity: ConversationContinuityService,
  userId: UserId,
  prepared: PreparedTurnContext
): Effect.Effect<AdmittedTurnOperations, ContinuityChanged | HostedAgentSessionConsentRequired> =>
  Effect.map(continuity.admitTurn({ userId, prepared }), ({ turnId }) => ({
    turnId,
    append: (entries) => continuity.appendTurn({ userId, turnId, entries }),
    complete: (assistant) => continuity.completeTurn({ userId, turnId, assistant }),
    fail: (reason) => continuity.failTurn({ userId, turnId, reason }),
  }));

const generatedMetadataProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const request = activeRequest("Necesito ayuda");
  const call = toolCallContent("generated");
  const result = toolResultContent(
    { _tag: "Succeeded", output: { retained: ["sí", 1, true] } },
    "generated"
  );

  yield* withPreparedTurn({ continuity, userId: defaultUserId, request }, (prepared) =>
    Effect.gen(function* () {
      expect(yield* continuity.observe(defaultUserId)).toEqual({ entries: [], turns: [] });
      const pending = yield* admitTurn(continuity, defaultUserId, prepared);
      const admitted = yield* continuity.observe(defaultUserId);
      expect(admitted.turns[0]?._tag).toBe("Pending");
      expect(admitted.entries).toHaveLength(1);
      expect(withoutMetadata(Option.getOrThrow(Arr.head(admitted.entries)))).toEqual({
        _tag: "UserTranscriptEntry",
        ...request,
      });
      yield* pending.append([call, result]);
      yield* pending.complete(assistantContent());
    })
  );

  const completed = yield* continuity.observe(defaultUserId);
  expect(completed.entries.map(withoutMetadata)).toEqual([
    { _tag: "UserTranscriptEntry", ...request },
    call,
    result,
    { _tag: "AssistantTranscriptEntry", ...assistantContent() },
  ]);
  assertGeneratedMetadata(completed);
});

const stalePreparedProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const migrationSql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("stale request must stay absent") },
    (prepared) =>
      Effect.gen(function* () {
        yield* migrationSql`
          UPDATE conversation_continuity
          SET revision = revision + 1
          WHERE user_id = ${defaultUserId}
        `;
        const changed = yield* Effect.flip(admitTurn(continuity, defaultUserId, prepared));
        assert.deepStrictEqual(changed, new ContinuityChanged());
      })
  );
  expect((yield* continuity.observe(defaultUserId)).entries).toEqual([]);
});

const staleMemoryPreparedProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const migrationSql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* withPreparedTurn(
    {
      continuity,
      userId: defaultUserId,
      request: activeRequest("stale memory request must stay absent"),
    },
    (prepared) =>
      Effect.gen(function* () {
        yield* migrationSql`
          INSERT INTO memory_revisions (user_id, revision)
          VALUES (${defaultUserId}, 1)
          ON CONFLICT (user_id) DO UPDATE
          SET revision = memory_revisions.revision + 1
        `;
        const changed = yield* Effect.flip(admitTurn(continuity, defaultUserId, prepared));
        assert.deepStrictEqual(changed, new ContinuityChanged());
      })
  );
  expect((yield* continuity.observe(defaultUserId)).entries).toEqual([]);
});

// The idle boundary is measured from the session's last terminal Turn, so the test backdates that
// evidence rather than waiting. `started_at` moves too: the table forbids a terminal Turn older
// than its session.
const idleBoundaryProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const first = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("primera sesion") },
    (prepared) =>
      Effect.flatMap(admitTurn(continuity, defaultUserId, prepared), (turn) =>
        turn.complete(assistantContent())
      ).pipe(Effect.as(prepared.snapshot.hostedAgentSessionId))
  );

  yield* sql`
    UPDATE hosted_agent_sessions
    SET started_at = started_at - interval '20 minutes',
        last_terminal_turn_at = last_terminal_turn_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND id = ${first}
  `;

  const second = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  expect(second).not.toBe(first);
  expect(
    yield* sql`
      SELECT id, status FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} ORDER BY started_at
    `
  ).toEqual([
    { id: first, status: "idle-ended" },
    { id: second, status: "active" },
  ]);
});

// A session whose first Turn never terminalized has no terminal evidence to measure from, so the
// boundary runs from `started_at`. Without that an orphan session would hold its captured Consent
// basis open forever.
const idleBoundaryWithoutTerminalTurnProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const first = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));
  expect(
    yield* sql`
      SELECT last_terminal_turn_at AS "lastTerminalTurnAt" FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} AND id = ${first}
    `
  ).toEqual([{ lastTerminalTurnAt: null }]);

  yield* sql`
    UPDATE hosted_agent_sessions SET started_at = started_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND id = ${first}
  `;

  const second = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  expect(second).not.toBe(first);
  expect(
    yield* sql`
      SELECT id, status FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} ORDER BY started_at
    `
  ).toEqual([
    { id: first, status: "idle-ended" },
    { id: second, status: "active" },
  ]);
});

// A Pending Turn is evidence of activity, not an exemption. Admission runs under the Turn lock, so
// any Pending Turn it observes was abandoned by a crashed or interrupted holder; letting one
// override the boundary would let an ancient session roll forward on its own recovery. Recovery is
// User-scoped, so the abandoned Turn is still terminalized under the fresh session.
const idleBoundaryWithAbandonedPendingTurnProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const first = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("turno abandonado") },
    (prepared) =>
      Effect.as(
        admitTurn(continuity, defaultUserId, prepared),
        prepared.snapshot.hostedAgentSessionId
      )
  );
  yield* sql`
    UPDATE hosted_agent_sessions SET started_at = started_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND id = ${first}
  `;
  yield* sql`
    UPDATE conversation_turns SET started_at = started_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND session_id = ${first}
  `;

  const second = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  expect(second).not.toBe(first);
  expect(
    yield* sql`
      SELECT id, status FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} ORDER BY started_at
    `
  ).toEqual([
    { id: first, status: "idle-ended" },
    { id: second, status: "active" },
  ]);
});

// The boundary always applies, but it measures from real activity: an unfinished Turn admitted a
// moment ago is the User still working, so a long-opened session continues on its evidence.
const idleBoundaryFromPendingTurnActivityProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const first = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("turno reciente") },
    (prepared) =>
      Effect.as(
        admitTurn(continuity, defaultUserId, prepared),
        prepared.snapshot.hostedAgentSessionId
      )
  );
  yield* sql`
    UPDATE hosted_agent_sessions SET started_at = started_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND id = ${first}
  `;

  const second = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  expect(second).toBe(first);
  expect(
    yield* sql`
      SELECT status FROM hosted_agent_sessions WHERE user_id = ${defaultUserId} AND id = ${first}
    `
  ).toEqual([{ status: "active" }]);
});

/**
 * Runs `use` while the User's onboarding grants sit on a superseded disclosure revision, which is
 * exactly the state a terms bump leaves them in. The revision is restored afterwards because the
 * default User's Consent is shared fixture state.
 */
const withStaleOnboardingGrants = <A, E, R>(
  use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | ConfigError | SqlError.SqlError, R | MigrationSqlClient> =>
  Effect.gen(function* () {
    const sql = yield* MigrationSqlClient;
    const disclosure = yield* currentDisclosure;
    const pinRevision = (revision: string): Effect.Effect<unknown, SqlError.SqlError> => sql`
      UPDATE consent_records SET disclosure_revision = ${revision}
      WHERE subject_user_id = ${defaultUserId}
        AND event_type = 'granted' AND grant_type = 'onboarding'
    `;
    yield* pinRevision("onboarding-2026-07");
    return yield* Effect.ensuring(use, Effect.orDie(pinRevision(disclosure.revision)));
  });

// Terms changes must not interrupt work already admitted: the captured basis governs the session it
// was captured for, so the recheck that guards each Turn ignores the newer revision.
const staleTermsKeepActiveSessionProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const session = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  yield* withStaleOnboardingGrants(
    Effect.gen(function* () {
      yield* continuity.requireSession(defaultUserId, session);
      const continued = yield* withUserTurnLock(
        defaultUserId,
        continuity.admitSession(defaultUserId)
      );

      expect(continued).toBe(session);
      expect(
        yield* sql`
          SELECT status FROM hosted_agent_sessions
          WHERE user_id = ${defaultUserId} AND id = ${session}
        `
      ).toEqual([{ status: "active" }]);
    })
  );
});

// The first request after the idle boundary is the point where current Consent is required again,
// so a session cannot be renewed on a basis the disclosure has since superseded.
const idleBoundaryRequiresCurrentConsentProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const session = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));
  yield* sql`
    UPDATE hosted_agent_sessions SET started_at = started_at - interval '20 minutes'
    WHERE user_id = ${defaultUserId} AND id = ${session}
  `;

  yield* withStaleOnboardingGrants(
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId))
      );

      expect(refused).toBeInstanceOf(HostedAgentSessionConsentRequired);
      expect(
        yield* sql`SELECT id FROM hosted_agent_sessions WHERE user_id = ${defaultUserId}`
      ).toEqual([{ id: session }]);
    })
  );
});

/** Fresh continuity with no session, which every session-boundary program starts from. */
const CapturedGrantRow = Schema.Tuple([Schema.Struct({ grantId: ConsentRecordId })]);

const consentDecision = (input: {
  readonly id: string;
  readonly event: typeof ConsentRecord.fields.event.Type;
  readonly occurredAt: string;
  readonly disclosure: typeof ConsentRecord.fields.disclosure.Type;
}): ConsentRecord =>
  ConsentRecord.make({
    id: ConsentRecordId.make(input.id),
    subjectUserId: defaultUserId,
    event: input.event,
    disclosure: input.disclosure,
    occurredAt: DateTime.makeUnsafe(input.occurredAt),
    evidence: {
      _tag: "ProviderQualifiedMessages",
      disclosureMessage: {
        channel: "test",
        provider: "test",
        providerMessageId: `${input.id}:disclosure`,
      },
      decisionMessage: {
        channel: "test",
        provider: "test",
        providerMessageId: `${input.id}:decision`,
      },
    },
  });

const capturedGrantId = (
  session: HostedAgentSessionId
): Effect.Effect<ConsentRecordId, Schema.SchemaError | SqlError.SqlError, MigrationSqlClient> =>
  Effect.gen(function* () {
    const sql = yield* MigrationSqlClient;
    const [row] = yield* Schema.decodeUnknownEffect(CapturedGrantRow)(
      yield* sql`
        SELECT consent_grant_id AS "grantId" FROM hosted_agent_sessions
        WHERE user_id = ${defaultUserId} AND id = ${session}
      `
    );
    return row.grantId;
  });

// The captured basis is what a later terms revision is compared against, so admission must copy the
// grant's exact revisions and digests instead of re-deriving them when the session is next used.
const consentBasisCaptureProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;

  const admitted = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));
  const basisColumns = sql.literal(
    `disclosure_revision AS "disclosureRevision", disclosure_sha256 AS "disclosureSha256", ` +
      `policy_revision AS "policyRevision", policy_sha256 AS "policySha256"`
  );
  const grant = yield* sql`
    SELECT id AS "grantId", ${basisColumns} FROM consent_records
    WHERE subject_user_id = ${defaultUserId} AND event_type = 'granted'
      AND grant_type = 'onboarding'
    ORDER BY occurred_at DESC, id DESC
    LIMIT 1
  `;
  const session = yield* sql`
    SELECT consent_grant_id AS "grantId", ${basisColumns} FROM hosted_agent_sessions
    WHERE user_id = ${defaultUserId} AND id = ${admitted}
  `;

  expect(grant).toHaveLength(1);
  expect(session).toEqual(grant);
});

// Revocation closes the session, but the unfinished Turn is durable recovery state: only recovery
// decides its terminal outcome, so revocation must leave the row Pending rather than erase it.
const pendingTurnSurvivesRevocationProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  const disclosure = yield* currentDisclosure;
  yield* resetDefaultContinuity;

  const session = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("turno sin terminar") },
    (prepared) =>
      Effect.as(
        admitTurn(continuity, defaultUserId, prepared),
        prepared.snapshot.hostedAgentSessionId
      )
  );
  const grantId = yield* capturedGrantId(session);
  yield* appendConsentRecord(
    consentDecision({
      id: "f1d1a000-0000-4000-8000-0000000004fe",
      event: { _tag: "Revoked", grantId },
      occurredAt: "2026-08-14T12:00:00Z",
      disclosure,
    })
  ).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const rejected = yield* Effect.flip(continuity.requireSession(defaultUserId, session));

  expect(rejected).toBeInstanceOf(HostedAgentSessionConsentRequired);
  expect(
    yield* sql`
      SELECT state FROM conversation_turns
      WHERE user_id = ${defaultUserId} AND session_id = ${session}
    `
  ).toEqual([{ state: "Pending" }]);
  // Revocation closes the session durably, so a User who revokes and never messages again does not
  // leave a session that still reads as active.
  expect(
    yield* sql`
      SELECT status FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} AND id = ${session}
    `
  ).toEqual([{ status: "revoked" }]);
});

// One active session per User is a database invariant, so a stale session that revocation left
// behind would refuse every later message. Admission closes it and opens a fresh one against
// current Consent, which is what lets a User who re-grants talk again.
const revokedSessionReadmissionProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  const disclosure = yield* currentDisclosure;
  yield* resetDefaultContinuity;
  const admit = withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));

  const first = yield* admit;
  const grantId = yield* capturedGrantId(first);
  const appendDecision = (record: ConsentRecord): Effect.Effect<void> =>
    appendConsentRecord(record).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.asVoid,
      Effect.orDie
    );
  yield* appendDecision(
    consentDecision({
      id: "f1d1a000-0000-4000-8000-000000000501",
      event: { _tag: "Revoked", grantId },
      occurredAt: "2026-08-14T12:00:00Z",
      disclosure,
    })
  );

  expect(yield* Effect.flip(admit)).toBeInstanceOf(HostedAgentSessionConsentRequired);

  yield* appendDecision(
    consentDecision({
      id: "f1d1a000-0000-4000-8000-000000000502",
      event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
      occurredAt: "2026-08-14T12:00:01Z",
      disclosure,
    })
  );
  const second = yield* admit;

  expect(second).not.toBe(first);
  expect(
    yield* sql`
      SELECT id, status FROM hosted_agent_sessions
      WHERE user_id = ${defaultUserId} ORDER BY started_at
    `
  ).toEqual([
    { id: first, status: "revoked" },
    { id: second, status: "active" },
  ]);
});

// Revocation targets the User's latest onboarding grant, which after a re-grant is no longer the
// one the active session pinned. The session must still close: the hosted seam and the PAT seam
// answer "is this User's Consent revoked" with one predicate, or a revoked User keeps a live agent.
const revokedLatestGrantClosesSessionProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  const disclosure = yield* currentDisclosure;
  yield* resetDefaultContinuity;

  const session = yield* withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId));
  const pinnedGrantId = yield* capturedGrantId(session);
  const appendDecision = (record: ConsentRecord): Effect.Effect<void> =>
    appendConsentRecord(record).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.asVoid,
      Effect.orDie
    );

  const regrantedId = ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000503");
  yield* appendDecision(
    consentDecision({
      id: regrantedId,
      event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
      occurredAt: "2026-08-14T12:00:00Z",
      disclosure,
    })
  );
  yield* appendDecision(
    consentDecision({
      id: "f1d1a000-0000-4000-8000-000000000504",
      event: { _tag: "Revoked", grantId: regrantedId },
      occurredAt: "2026-08-14T12:00:01Z",
      disclosure,
    })
  );

  const rejected = yield* Effect.flip(continuity.requireSession(defaultUserId, session));

  expect(pinnedGrantId).not.toBe(regrantedId);
  expect(rejected).toBeInstanceOf(HostedAgentSessionConsentRequired);
});

// Revocation targets the latest grant, not every grant a User ever accepted. Admission must read
// the same standing every other credential reads, or an earlier unrevoked grant would still admit
// hosted work while the PAT seam refuses on the revocation the User actually performed.
const revokedLatestGrantRefusesAdmissionProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  const disclosure = yield* currentDisclosure;
  yield* resetDefaultContinuity;

  const appendDecision = (record: ConsentRecord): Effect.Effect<void> =>
    appendConsentRecord(record).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.asVoid,
      Effect.orDie
    );

  const laterGrantId = ConsentRecordId.make("f1d1a000-0000-4000-8000-000000000505");
  yield* appendDecision(
    consentDecision({
      id: laterGrantId,
      event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
      occurredAt: "2026-08-14T13:00:00Z",
      disclosure,
    })
  );
  yield* appendDecision(
    consentDecision({
      id: "f1d1a000-0000-4000-8000-000000000506",
      event: { _tag: "Revoked", grantId: laterGrantId },
      occurredAt: "2026-08-14T13:00:01Z",
      disclosure,
    })
  );

  const refused = yield* Effect.flip(
    withUserTurnLock(defaultUserId, continuity.admitSession(defaultUserId))
  );

  expect(refused).toBeInstanceOf(HostedAgentSessionConsentRequired);
  expect(yield* sql`SELECT id FROM hosted_agent_sessions WHERE user_id = ${defaultUserId}`).toEqual(
    []
  );
});

const prepareAndInspectRecovery = (
  continuity: ConversationContinuityService,
  expectedCall: TurnContinuationContent
): Effect.Effect<void, HostedAgentSessionConsentRequired, SqlClient.SqlClient> =>
  withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("next request") },
    () =>
      continuity.observe(defaultUserId).pipe(
        Effect.tap((view) =>
          Effect.sync(() => {
            expect(view.turns[0]?._tag).toBe("Interrupted");
            expect(view.entries.map(withoutMetadata)).toEqual([
              { _tag: "UserTranscriptEntry", ...activeRequest("recover me") },
              expectedCall,
              { _tag: "InterruptedTurnTranscriptEntry" },
            ]);
          })
        )
      )
  );

const assertSingleInterruption = (
  continuity: ConversationContinuityService
): Effect.Effect<void, HostedAgentSessionConsentRequired, SqlClient.SqlClient> =>
  withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("later request") },
    () =>
      continuity
        .observe(defaultUserId)
        .pipe(
          Effect.map((view) =>
            expect(
              view.entries.filter((entry) => entry._tag === "InterruptedTurnTranscriptEntry")
            ).toHaveLength(1)
          )
        )
  );

const recoveryProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  let abandoned = Option.none<AdmittedTurnOperations>();
  const call = toolCallContent("recovery");
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("recover me") },
    (prepared) =>
      Effect.gen(function* () {
        abandoned = Option.some(yield* admitTurn(continuity, defaultUserId, prepared));
        yield* Option.getOrThrow(abandoned).append([call]);
      })
  );
  expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
  yield* prepareAndInspectRecovery(continuity, call);
  yield* assertSingleInterruption(continuity);
  // Recovery terminalized the Turn, so naming it again finds no Pending row and dies.
  const recovered = Option.getOrThrow(abandoned);
  assertDefect(yield* recovered.append([toolCallContent("escaped")]).pipe(Effect.exit));
});

const recoveryTimestampProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("recover chronology") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        yield* pending.append([toolCallContent("future")]);
      })
  );

  const latestPersistedAt = DateTime.makeUnsafe("2099-08-12T12:00:00.000Z");
  yield* sql`
    UPDATE transcript_entries
    SET entry = jsonb_set(
      entry,
      '{occurredAt}',
      to_jsonb(${DateTime.formatIso(latestPersistedAt)}::text)
    )
    WHERE user_id = ${defaultUserId}
      AND entry->>'_tag' = 'CanonicalToolCallEntry'
  `;

  const assertRecoveryTime = (): Effect.Effect<void> =>
    continuity.observe(defaultUserId).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          const interruption = Option.getOrThrow(
            Arr.findFirst(view.entries, (entry) => entry._tag === "InterruptedTurnTranscriptEntry")
          );
          expect(interruption.occurredAt).toEqual(latestPersistedAt);
          const interruptedTurn = Option.getOrThrow(
            Arr.findFirst(view.turns, (turn) => turn._tag === "Interrupted")
          );
          expect(interruptedTurn.terminalAt).toEqual(latestPersistedAt);
        })
      )
    );
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("next request") },
    () => assertRecoveryTime()
  );
});

/**
 * Once-only terminalization is a durable property, not a retained capability: every operation
 * rechecks Pending state inside its own transaction, so naming an already-terminal Turn dies.
 */
const durableTerminalizationProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const terminal = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("terminal") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        yield* pending.complete(assistantContent("done"));
        assertDefect(yield* pending.fail("DeliveryFailed").pipe(Effect.exit));
        return pending;
      })
  );
  assertDefect(yield* terminal.append([toolCallContent("after-terminal")]).pipe(Effect.exit));
  assertDefect(yield* terminal.complete(assistantContent("again")).pipe(Effect.exit));
  expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(2);
});

const fixedFailureProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const canary = "caller-prose-fixed-failure-canary";
  const reasons: ReadonlyArray<TurnFailureReason> = [
    "HostedInferenceFailed",
    "HostedInferenceTimedOut",
    "DeliveryFailed",
  ];

  for (const reason of reasons) {
    yield* resetDefaultContinuity;
    yield* withPreparedTurn(
      { continuity, userId: defaultUserId, request: activeRequest(canary) },
      (prepared) =>
        Effect.gen(function* () {
          const pending = yield* admitTurn(continuity, defaultUserId, prepared);
          yield* pending.fail(reason);
        })
    );
    const failed = yield* continuity.observe(defaultUserId);
    expect(failed.turns[0]).toMatchObject({ _tag: "Failed", reason });
    const terminal = Option.getOrThrow(Arr.last(failed.entries));
    expect(withoutMetadata(terminal)).toEqual({ _tag: "FailedTurnTranscriptEntry", reason });
    const serializedTerminal = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(terminal);
    expect(serializedTerminal).not.toContain(canary);
    expect(projectTranscriptForModel(failed.entries, 1_000)).toEqual([failed.entries[0]]);
  }
});

const outcomeRoundTripProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const contents: Arr.NonEmptyReadonlyArray<TurnContinuationContent> = [
    toolResultContent({ _tag: "Succeeded", output: { exact: "é" } }, "outcome-0", 1),
    toolResultContent(
      { _tag: "ToolInputRejected", failure: { code: "bad_input" } },
      "outcome-1",
      2
    ),
    toolResultContent(
      { _tag: "ToolOutputRejected", failure: { code: "bad_output" } },
      "outcome-2",
      3
    ),
    toolResultContent(
      { _tag: "CanonicalOperationFailed", failure: { code: "failed" } },
      "outcome-3",
      4
    ),
  ];
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("all outcomes") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        yield* pending.append(contents);
        yield* pending.complete(assistantContent("complete", 5));
      })
  );
  const persisted = (yield* continuity.observe(defaultUserId)).entries.slice(1, -1);
  expect(persisted.map(withoutMetadata)).toEqual(contents);
});

const maximumPayloadProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const maximumText = "é".repeat(16_000);
  const maximumEvidence = "é".repeat(499_999);
  const call = toolCallContent("maximum-call", maximumEvidence);
  const maximumOutcomes: ReadonlyArray<CanonicalToolOutcome> = [
    { _tag: "Succeeded", output: maximumEvidence },
    { _tag: "ToolInputRejected", failure: maximumEvidence },
    { _tag: "ToolOutputRejected", failure: maximumEvidence },
    { _tag: "CanonicalOperationFailed", failure: maximumEvidence },
  ];
  const contents: Arr.NonEmptyReadonlyArray<TurnContinuationContent> = [
    call,
    ...maximumOutcomes.map((outcome, index) =>
      toolResultContent(outcome, `maximum-result-${index}`, index + 1)
    ),
  ];
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest(maximumText) },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        yield* pending.append(contents);
        yield* pending.complete(assistantContent(maximumText, 5));
      })
  );
  expect((yield* continuity.observe(defaultUserId)).entries.map(withoutMetadata)).toEqual([
    { _tag: "UserTranscriptEntry", ...activeRequest(maximumText) },
    ...contents,
    { _tag: "AssistantTranscriptEntry", ...assistantContent(maximumText, 5) },
  ]);
});

const generatedContentProgram = (
  entry: TranscriptContentEntry
): Effect.Effect<
  void,
  ContinuityChanged | HostedAgentSessionConsentRequired | SqlError.SqlError,
  ConversationContinuity | MigrationSqlClient | Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const continuity = yield* ConversationContinuity;
    yield* resetDefaultContinuity;
    const request =
      entry._tag === "UserTranscriptEntry"
        ? { text: entry.text }
        : activeRequest("generated entry round-trip");
    yield* withPreparedTurn({ continuity, userId: defaultUserId, request }, (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        switch (entry._tag) {
          case "UserTranscriptEntry":
            break;
          case "AssistantTranscriptEntry":
            yield* pending.complete({ iteration: entry.iteration, text: entry.text });
            break;
          case "CanonicalToolCallEntry": {
            const { id: _id, turnId: _turnId, occurredAt: _occurredAt, ...content } = entry;
            yield* pending.append([content]);
            break;
          }
          case "CanonicalToolResultEntry": {
            const { id: _id, turnId: _turnId, occurredAt: _occurredAt, ...content } = entry;
            yield* pending.append([content]);
            break;
          }
        }
      })
    );
    const observed = yield* continuity.observe(defaultUserId);
    expect(withoutMetadata(Option.getOrThrow(Arr.last(observed.entries)))).toEqual(
      withoutMetadata(entry)
    );
  });

const malformedRequestProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const secret = "request-secret\u0000";
  const malformed = yield* Schema.decodeUnknownEffect(ForgedActiveTurnRequest)({ text: secret });
  const rejected = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: malformed },
    () => Effect.void
  ).pipe(Effect.exit);
  assertContentFreeDefect(rejected, secret);
  expect(yield* continuity.observe(defaultUserId)).toEqual({ entries: [], turns: [] });
});

const malformedContinuationProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const secret = "continuation-secret\u0000";
  const malformed = yield* Schema.decodeUnknownEffect(ForgedContinuationContent)({
    ...toolCallContent("malformed"),
    input: { secret },
  });
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("continue safely") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        const rejected = yield* pending.append([malformed]).pipe(Effect.exit);
        assertContentFreeDefect(rejected, secret);
        expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(1);
        yield* pending.append([toolCallContent("corrected")]);
        yield* pending.complete(assistantContent("corrected"));
      })
  );
});

const malformedAssistantProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const secret = "assistant-secret\u0000";
  const malformed = yield* Schema.decodeUnknownEffect(ForgedAssistantContent)({
    ...assistantContent(),
    text: secret,
  });
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("complete safely") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        const rejected = yield* pending.complete(malformed).pipe(Effect.exit);
        assertContentFreeDefect(rejected, secret);
        expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
        yield* pending.complete(assistantContent("corrected"));
      })
  );
  expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Completed");
});

const malformedFailureProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const secret = "failure-reason-secret";
  const malformed = yield* Schema.decodeUnknownEffect(ForgedTurnFailureReason)(secret);
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("fail safely") },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        const rejected = yield* pending.fail(malformed).pipe(Effect.exit);
        assertContentFreeDefect(rejected, secret);
        expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
        yield* pending.fail("DeliveryFailed");
      })
  );
  expect((yield* continuity.observe(defaultUserId)).turns[0]).toMatchObject({
    _tag: "Failed",
    reason: "DeliveryFailed",
  });
});

const malformedPersistedEntryProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("persisted secret") },
    (prepared) => Effect.asVoid(admitTurn(continuity, defaultUserId, prepared))
  );

  const secret = "persisted-transcript-secret";
  const malformedEntry = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
    _tag: "UserTranscriptEntry",
    text: secret,
  });
  yield* sql`
    UPDATE transcript_entries SET entry = ${malformedEntry}::jsonb
    WHERE user_id = ${defaultUserId}
  `;

  const observed = yield* continuity.observe(defaultUserId).pipe(Effect.exit);
  assertContentFreeDefect(observed, secret);

  const prepared = yield* withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("must roll back recovery") },
    () => Effect.void
  ).pipe(Effect.exit);
  assertContentFreeDefect(prepared, secret);

  expect(
    yield* sql`
      SELECT state, terminal_at AS "terminalAt" FROM conversation_turns
      WHERE user_id = ${defaultUserId}
    `
  ).toEqual([{ state: "Pending", terminalAt: null }]);
  expect(
    yield* sql`
      SELECT count(*)::int AS count FROM transcript_entries
      WHERE user_id = ${defaultUserId}
    `
  ).toEqual([{ count: 1 }]);
});

const beginPending = (
  continuity: ConversationContinuityService,
  userId: UserId,
  request: ActiveTurnRequest
): Effect.Effect<
  void,
  ContinuityChanged | HostedAgentSessionConsentRequired,
  SqlClient.SqlClient
> =>
  withPreparedTurn({ continuity, userId, request }, (prepared) =>
    Effect.asVoid(admitTurn(continuity, userId, prepared))
  );

const completeIsolatedTurn = (
  continuity: ConversationContinuityService
): Effect.Effect<
  void,
  ContinuityChanged | HostedAgentSessionConsentRequired,
  SqlClient.SqlClient
> =>
  withPreparedTurn(
    { continuity, userId: isolatedUserId, request: activeRequest("second user") },
    (prepared) =>
      Effect.gen(function* () {
        expect(yield* continuity.observe(isolatedUserId)).toEqual({ entries: [], turns: [] });
        const pending = yield* admitTurn(continuity, isolatedUserId, prepared);
        yield* pending.complete(assistantContent("second complete"));
      })
  );

const recoverFirstUser = (
  continuity: ConversationContinuityService
): Effect.Effect<void, HostedAgentSessionConsentRequired, SqlClient.SqlClient> =>
  withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest("recover first") },
    () =>
      continuity
        .observe(defaultUserId)
        .pipe(Effect.map((view) => expect(view.turns[0]?._tag).toBe("Interrupted")))
  );

const userIsolationProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  yield* resetIsolatedUser;
  yield* beginPending(continuity, defaultUserId, activeRequest("first user"));
  yield* completeIsolatedTurn(continuity);
  const secondBeforeRecovery = yield* continuity.observe(isolatedUserId);
  yield* recoverFirstUser(continuity);
  const first = yield* continuity.observe(defaultUserId);
  const second = yield* continuity.observe(isolatedUserId);
  expect(first.entries.map(withoutMetadata)).toEqual([
    { _tag: "UserTranscriptEntry", ...activeRequest("first user") },
    { _tag: "InterruptedTurnTranscriptEntry" },
  ]);
  expect(second).toEqual(secondBeforeRecovery);
  expect(second.entries.map(withoutMetadata)).toEqual([
    { _tag: "UserTranscriptEntry", ...activeRequest("second user") },
    { _tag: "AssistantTranscriptEntry", ...assistantContent("second complete") },
  ]);
});

const completeTestTurn = (
  continuity: ConversationContinuityService,
  text: string
): Effect.Effect<
  void,
  ContinuityChanged | HostedAgentSessionConsentRequired,
  SqlClient.SqlClient
> =>
  withPreparedTurn(
    { continuity, userId: defaultUserId, request: activeRequest(text) },
    (prepared) =>
      Effect.gen(function* () {
        const pending = yield* admitTurn(continuity, defaultUserId, prepared);
        yield* pending.complete(assistantContent());
      })
  );

const concurrentCompactionProgram = Effect.scoped(
  Effect.gen(function* () {
    const continuity = yield* ConversationContinuity;
    const control = yield* CompactionRaceControl;
    const sql = yield* MigrationSqlClient;
    yield* resetDefaultContinuity;
    yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
    yield* completeTestTurn(continuity, "primero");
    yield* completeTestTurn(continuity, "segundo");
    const gate = yield* control.arm(undefined, true);

    yield* withUserTurnLock(
      defaultUserId,
      Effect.gen(function* () {
        const hostedAgentSessionId = yield* continuity.admitSession(defaultUserId);
        const prepare = continuity.prepareTurn(
          defaultUserId,
          hostedAgentSessionId,
          activeRequest("concurrent compaction")
        );
        const older = yield* Effect.forkChild(prepare);
        yield* Deferred.await(gate.entered);
        const newer = yield* Effect.forkChild(prepare);
        yield* Deferred.await(gate.enteredAgain);

        // Release the newer generation first. The older generation must then lose its optimistic
        // commit rather than overwrite the newer replacement or delete its retained entries.
        yield* Deferred.succeed(gate.releaseNewer, undefined);
        const newerExit = yield* Fiber.await(newer);
        expect(Exit.isSuccess(newerExit)).toBe(true);
        expect(yield* Ref.get(gate.commitResults)).toEqual(["Committed"]);
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toEqual([{ text: "newer-compaction" }]);

        const protectedTurnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-0000000005f1");
        const protectedEntry = UserTranscriptEntry.make({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-0000000005f2"),
          turnId: protectedTurnId,
          occurredAt: DateTime.makeUnsafe("2026-08-15T12:00:02Z"),
          text: TranscriptText.make("protected newer attempt entry"),
        });
        const protectedPersistedEntry = encodePersistedTranscriptEntry(protectedEntry);
        yield* sql`
          INSERT INTO conversation_turns (user_id, session_id, id, state, started_at, terminal_at)
          VALUES (
            ${defaultUserId},
            (SELECT id FROM hosted_agent_sessions
              WHERE user_id = ${defaultUserId} AND status = 'active'),
            ${protectedTurnId},
            'Completed',
            ${protectedEntry.occurredAt},
            ${protectedEntry.occurredAt}
          )
        `;
        yield* sql`
          INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
          VALUES (
            ${defaultUserId},
            ${protectedEntry.id},
            ${protectedEntry.turnId},
            ${protectedPersistedEntry}::jsonb
          )
        `;
        yield* sql`
          UPDATE conversation_continuity
          SET revision = revision + 1
          WHERE user_id = ${defaultUserId}
        `;
        yield* Deferred.succeed(gate.releaseOlder, undefined);

        // The older generation still prepares, but its compaction commit is refused as stale, so
        // it neither replaces the newer text nor deletes the entries that text stands for.
        const olderExit = yield* Fiber.await(older);
        expect(Exit.isSuccess(olderExit)).toBe(true);
        expect(yield* Ref.get(gate.commitResults)).toEqual(["Committed", "Stale"]);
        expect(
          yield* sql`SELECT entry_id AS "entryId" FROM transcript_entries
            WHERE user_id = ${defaultUserId} AND entry_id = ${protectedEntry.id}`
        ).toEqual([{ entryId: String(protectedEntry.id) }]);
      })
    );

    expect(
      yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
    ).toEqual([{ text: "newer-compaction" }]);
    const retained = (yield* continuity.observe(defaultUserId)).entries;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      text: TranscriptText.make("protected newer attempt entry"),
    });
  })
);

layer(TokenScenarioCompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity token-only Compaction",
  (it) => {
    it.effect("does not trigger from many messages or retained bytes without enough tokens", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        for (const index of Arr.range(1, 8)) {
          yield* completeTestTurn(continuity, `small:${index}:${"x".repeat(2_000)}`);
        }
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(0);
      })
    );

    it.effect("triggers from a few large-token turns independently of retained bytes", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "large:a");
        yield* completeTestTurn(continuity, "large:b");
        yield* completeTestTurn(continuity, "probe");
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(1);
      })
    );

    it.effect("keeps the decision equal for equal tokens with different byte volume", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "token:a");
        yield* completeTestTurn(continuity, `token:${"界".repeat(2_000)}`);
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(0);
        yield* completeTestTurn(continuity, "token:c");
        yield* completeTestTurn(continuity, "probe");
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(1);
      })
    );

    it.effect("feeds prior state and only post-cursor exact entries into a second compaction", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "token:first");
        yield* completeTestTurn(continuity, "token:second");
        yield* completeTestTurn(continuity, "token:third");
        yield* completeTestTurn(continuity, "token:fourth");
        const first = yield* sql`
          SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `;
        yield* completeTestTurn(continuity, "token:fifth");
        yield* completeTestTurn(continuity, "token:sixth");
        yield* completeTestTurn(continuity, "token:seventh");
        yield* completeTestTurn(continuity, "probe");
        const second = yield* sql`
          SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `;
        const firstText = first[0]?.text;
        expect(firstText).toContain("token:first");
        expect(second[0]?.text).toBe(`${String(firstText)}|token:fourth,token:fifth,token:sixth`);
      })
    );
  }
);

layer(FixedFailureCompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity fixed Compaction failures",
  (it) => {
    it.effect("deletes nothing across failed malformed and oversized Compaction", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const control = yield* CompactionFailureControl;
        const sql = yield* MigrationSqlClient;
        const modes: ReadonlyArray<FixedCompactionFailure> = ["failed", "malformed", "oversized"];

        for (const mode of modes) {
          yield* resetDefaultContinuity;
          yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
          yield* completeTestTurn(continuity, "primero");
          yield* completeTestTurn(continuity, "segundo");
          const before = yield* continuity.observe(defaultUserId);
          yield* control.select(mode);
          yield* completeTestTurn(continuity, "tercero");
          const after = yield* continuity.observe(defaultUserId);
          expect(
            yield* sql`SELECT text FROM compacted_conversations
                WHERE user_id = ${defaultUserId}`
          ).toHaveLength(0);
          expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
          expect(after.entries).toHaveLength(before.entries.length + 2);
        }
      })
    );

    it.effect("retries Compaction without losing exact Transcript after inference failure", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const control = yield* CompactionFailureControl;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        yield* control.select("failed");
        yield* completeTestTurn(continuity, "tercero");

        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(0);
        expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(6);

        yield* control.select("success");
        yield* completeTestTurn(continuity, "cuarto");
        const recovered = yield* continuity.observe(defaultUserId);
        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toEqual([{ text: "recovered" }]);
        expect(recovered.entries).toHaveLength(4);
      })
    );
  }
);

layer(TimeoutCompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity timed-out Compaction",
  (it) => {
    it.effect("times out inference without deleting exact Transcript", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const control = yield* CompactionFailureControl;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        const before = yield* continuity.observe(defaultUserId);
        yield* control.select("timed-out");
        const pending = yield* completeTestTurn(continuity, "tercero").pipe(
          Effect.forkChild({ startImmediately: true })
        );
        yield* Deferred.await(control.generationStarted);
        yield* TestClock.adjust("31 seconds");
        yield* Fiber.join(pending);

        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(0);
        const after = yield* continuity.observe(defaultUserId);
        expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
        expect(after.entries).toHaveLength(before.entries.length + 2);
      })
    );
  }
);

layer(OversizedCompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity bounded Compaction",
  (it) => {
    it.effect("keeps exact Transcript when generated replacement exceeds its token bound", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        yield* completeTestTurn(continuity, "tercero");
        expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(6);
        yield* sql`DELETE FROM transcript_entries WHERE user_id = ${defaultUserId}`;
        yield* sql`DELETE FROM conversation_turns WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "debajo del umbral");
        yield* completeTestTurn(continuity, "todavía debajo");
        expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(4);
      })
    );
  }
);

layer(ConsentLockedCompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity consent-locked Compaction",
  (it) => {
    it.effect(
      "keeps concurrent Compaction generations from committing out of order",
      () => concurrentCompactionProgram
    );

    it.effect(
      "leaves Consent unlocked while generation is blocked",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const continuity = yield* ConversationContinuity;
            const control = yield* CompactionRaceControl;
            const sql = yield* MigrationSqlClient;
            yield* resetDefaultContinuity;
            yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
            yield* completeTestTurn(continuity, "primero");
            yield* completeTestTurn(continuity, "segundo");
            const gate = yield* control.arm();
            const compacting = yield* completeTestTurn(continuity, "tercero").pipe(
              Effect.forkChild
            );
            yield* Deferred.await(gate.entered);

            const lockKey = advisoryLockKey.consentSubject(defaultUserId);
            const consentMutationEntered = yield* Deferred.make<void>();
            const consentMutation = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql`
                    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey.value}, ${lockKey.seed}))
                  `;
                  yield* Deferred.succeed(consentMutationEntered, undefined);
                })
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(consentMutationEntered);

            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(compacting);
            yield* Fiber.join(consentMutation);
          })
        ),
      30_000
    );

    // The captured basis governs the session it was captured for, so a terms revision must not stall
    // Compaction. Reading current-terms grants instead stops it for the session's whole life and
    // lets the exact Transcript grow past its trigger unbounded.
    it.effect("keeps compacting a session whose basis a terms revision superseded", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        const before = yield* withUserTurnLock(
          defaultUserId,
          continuity.admitSession(defaultUserId)
        );

        yield* withStaleOnboardingGrants(
          Effect.gen(function* () {
            yield* completeTestTurn(continuity, "segundo");
            yield* completeTestTurn(continuity, "tercero");
            const after = yield* withUserTurnLock(
              defaultUserId,
              continuity.admitSession(defaultUserId)
            );

            expect(after).toBe(before);
            expect(
              yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
            ).toHaveLength(1);
          })
        );
      })
    );

    it.effect(
      "deletes nothing across Consent revoke and re-grant ABA during generation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const continuity = yield* ConversationContinuity;
            const control = yield* CompactionRaceControl;
            const sql = yield* MigrationSqlClient;
            yield* resetDefaultContinuity;
            yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
            const disclosure = yield* currentDisclosure;
            const grantId = ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000004fb");
            yield* appendConsentRecord(
              ConsentRecord.make({
                id: grantId,
                subjectUserId: defaultUserId,
                event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
                disclosure,
                occurredAt: DateTime.makeUnsafe("2026-08-13T11:59:59Z"),
                evidence: {
                  _tag: "ProviderQualifiedMessages",
                  disclosureMessage: {
                    channel: "test",
                    provider: "test",
                    providerMessageId: "compaction-aba-initial-disclosure",
                  },
                  decisionMessage: {
                    channel: "test",
                    provider: "test",
                    providerMessageId: "compaction-aba-initial-decision",
                  },
                },
              })
            );
            yield* completeTestTurn(continuity, "primero");
            yield* completeTestTurn(continuity, "segundo");
            const before = yield* continuity.observe(defaultUserId);
            const mutateConsent = Effect.gen(function* () {
              yield* appendConsentRecord(
                ConsentRecord.make({
                  id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000004fc"),
                  subjectUserId: defaultUserId,
                  event: { _tag: "Revoked", grantId },
                  disclosure,
                  occurredAt: DateTime.makeUnsafe("2026-08-13T12:00:00Z"),
                  evidence: {
                    _tag: "ProviderQualifiedMessages",
                    disclosureMessage: {
                      channel: "test",
                      provider: "test",
                      providerMessageId: "compaction-aba-revoke-disclosure",
                    },
                    decisionMessage: {
                      channel: "test",
                      provider: "test",
                      providerMessageId: "compaction-aba-revoke-decision",
                    },
                  },
                })
              );
              yield* appendConsentRecord(
                ConsentRecord.make({
                  id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000004fd"),
                  subjectUserId: defaultUserId,
                  event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
                  disclosure,
                  occurredAt: DateTime.makeUnsafe("2026-08-13T12:00:01Z"),
                  evidence: {
                    _tag: "ProviderQualifiedMessages",
                    disclosureMessage: {
                      channel: "test",
                      provider: "test",
                      providerMessageId: "compaction-aba-grant-disclosure",
                    },
                    decisionMessage: {
                      channel: "test",
                      provider: "test",
                      providerMessageId: "compaction-aba-grant-decision",
                    },
                  },
                })
              );
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            const gate = yield* control.arm(mutateConsent);
            const compacting = yield* completeTestTurn(continuity, "tercero").pipe(
              Effect.forkChild
            );
            yield* Deferred.await(gate.entered);
            yield* Deferred.succeed(gate.release, undefined);
            // Revocation closed the session the racing attempt was admitted under, so its Turn is
            // refused; the re-grant only opens the next session.
            const refused = yield* Fiber.await(compacting);
            expect(Exit.isFailure(refused)).toBe(true);
            if (Exit.isFailure(refused)) {
              expect(Option.map(Cause.findErrorOption(refused.cause), hostedSessionClosed)).toEqual(
                Option.some(true)
              );
            }

            expect(
              yield* sql`
              SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
            `
            ).toHaveLength(0);
            const observed = yield* continuity.observe(defaultUserId);
            expect(observed.entries).toEqual(before.entries);
          })
        ),
      30_000
    );

    it.effect(
      "deletes nothing when continuity revision changes after generation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const continuity = yield* ConversationContinuity;
            const control = yield* CompactionRaceControl;
            const sql = yield* MigrationSqlClient;
            yield* resetDefaultContinuity;
            yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
            yield* completeTestTurn(continuity, "primero");
            yield* completeTestTurn(continuity, "segundo");
            const before = yield* continuity.observe(defaultUserId);
            const gate = yield* control.arm(
              sql`UPDATE conversation_continuity
                SET revision = revision + 1
                WHERE user_id = ${defaultUserId}`.pipe(Effect.orDie, Effect.asVoid)
            );
            const compacting = yield* completeTestTurn(continuity, "tercero").pipe(
              Effect.forkChild
            );
            yield* Deferred.await(gate.entered);
            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(compacting);

            expect(
              yield* sql`SELECT text FROM compacted_conversations
                WHERE user_id = ${defaultUserId}`
            ).toHaveLength(0);
            const observed = yield* continuity.observe(defaultUserId);
            expect(observed.entries.slice(0, before.entries.length)).toEqual(before.entries);
            expect(observed.entries).toHaveLength(before.entries.length + 2);
          })
        ),
      30_000
    );

    it.effect(
      "reloads exact continuity and deletes nothing when Memory changes after generation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const continuity = yield* ConversationContinuity;
            const control = yield* CompactionRaceControl;
            const sql = yield* MigrationSqlClient;
            yield* resetDefaultContinuity;
            yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
            yield* completeTestTurn(continuity, "primero");
            yield* completeTestTurn(continuity, "segundo");
            const before = yield* continuity.observe(defaultUserId);
            const gate = yield* control.arm(
              sql`
                INSERT INTO memory_revisions (user_id, revision)
                VALUES (${defaultUserId}, 1)
                ON CONFLICT (user_id) DO UPDATE
                SET revision = memory_revisions.revision + 1
              `.pipe(Effect.orDie, Effect.asVoid)
            );
            const compacting = yield* completeTestTurn(continuity, "tercero").pipe(
              Effect.forkChild
            );
            yield* Deferred.await(gate.entered);
            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(compacting);

            const observed = yield* continuity.observe(defaultUserId);
            const compacted = yield* sql`
              SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
            `;
            expect(compacted).toHaveLength(0);
            expect(observed.entries.slice(0, before.entries.length)).toEqual(before.entries);
            expect(observed.entries).toHaveLength(before.entries.length + 2);
          })
        ),
      30_000
    );
  }
);

layer(CompactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity Compaction",
  (it) => {
    it.effect("compacts complete turns at the token threshold and retains Turn metadata", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        yield* completeTestTurn(continuity, "tercero");

        const observed = yield* continuity.observe(defaultUserId);
        const [compacted] = yield* sql`
          SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `;
        expect(compacted?.text).toBe("resumen fiel");
        expect(observed.entries).toHaveLength(2);
        expect(observed.turns).toHaveLength(3);
      })
    );

    it.effect("rewrites the User's sole CompactedConversation", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        yield* completeTestTurn(continuity, "tercero");
        yield* sql`UPDATE compacted_conversations
          SET updated_at = '2000-01-01T00:00:00Z'::timestamptz
          WHERE user_id = ${defaultUserId}`;
        const before = yield* sql`
          SELECT text, through_sequence AS "throughSequence", revision,
                 updated_at AS "updatedAt"
          FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `;

        yield* completeTestTurn(continuity, "cuarto");
        yield* completeTestTurn(continuity, "quinto");
        const replaced = yield* sql`
          SELECT text, through_sequence AS "throughSequence", revision,
                 updated_at AS "updatedAt"
          FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `;
        expect(replaced).toHaveLength(1);
        expect(replaced[0]?.updatedAt).toBeDefined();
        expect(Number(replaced[0]?.revision)).toBeGreaterThan(Number(before[0]?.revision));

        const primaryKey = yield* sql`
          SELECT constraint_type AS "constraintType"
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'compacted_conversations'
            AND constraint_type = 'PRIMARY KEY'
        `;
        expect(primaryKey).toHaveLength(1);
        // Selecting the existing row's own session reproduces the exact composite key, so the
        // refusal is the uniqueness constraint rather than a missing column.
        const duplicate = yield* sql`
          INSERT INTO compacted_conversations
            (user_id, session_id, text, through_sequence, revision, updated_at)
          SELECT user_id, session_id, 'duplicate', 0, 1, now()
          FROM compacted_conversations WHERE user_id = ${defaultUserId}
        `.pipe(Effect.exit);
        expect(Exit.isFailure(duplicate)).toBe(true);
        expect(
          yield* sql`
            SELECT text, through_sequence AS "throughSequence", revision,
                   updated_at AS "updatedAt"
            FROM compacted_conversations WHERE user_id = ${defaultUserId}
          `
        ).toEqual(replaced);
      })
    );

    it.effect("rolls back replacement when persistence fails before exact-prefix deletion", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        const sql = yield* MigrationSqlClient;
        yield* resetDefaultContinuity;
        yield* sql`DELETE FROM compacted_conversations WHERE user_id = ${defaultUserId}`;
        yield* completeTestTurn(continuity, "primero");
        yield* completeTestTurn(continuity, "segundo");
        const before = yield* continuity.observe(defaultUserId);
        yield* sql`
          CREATE OR REPLACE FUNCTION fail_test_compaction_write() RETURNS trigger AS $$
          BEGIN
            IF NEW.user_id = 'f1d1a000-0000-4000-8000-000000000001'::uuid THEN
              RAISE EXCEPTION 'injected compaction persistence failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `;
        yield* sql`
          CREATE TRIGGER fail_test_compaction_write
          AFTER INSERT OR UPDATE ON compacted_conversations
          FOR EACH ROW EXECUTE FUNCTION fail_test_compaction_write()
        `;
        yield* completeTestTurn(continuity, "tercero").pipe(
          Effect.ensuring(
            sql`DROP TRIGGER IF EXISTS fail_test_compaction_write ON compacted_conversations`.pipe(
              Effect.andThen(sql`DROP FUNCTION IF EXISTS fail_test_compaction_write()`),
              Effect.orDie
            )
          )
        );

        expect(
          yield* sql`SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}`
        ).toHaveLength(0);
        const after = yield* continuity.observe(defaultUserId);
        expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries);
        expect(after.entries).toHaveLength(before.entries.length + 2);
      })
    );
  }
);

layer(ContinuityHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity",
  (it) => {
    it.effect("persists explicit Pending Completed Failed and Interrupted Turn states", () =>
      Effect.all([generatedMetadataProgram, fixedFailureProgram, recoveryProgram], {
        concurrency: 1,
        discard: true,
      })
    );
    it.effect(
      "generates persistence metadata for a Pending to Completed Turn",
      () => generatedMetadataProgram
    );
    it.effect(
      "returns ContinuityChanged without appending a stale active request",
      () => stalePreparedProgram
    );
    it.effect(
      "returns ContinuityChanged when Memory changes after preparation",
      () => staleMemoryPreparedProgram
    );
    it.effect(
      "recovers an abandoned Pending Turn exactly once as Interrupted",
      () => recoveryProgram
    );
    it.effect(
      "ends an idle session at its boundary and admits a fresh one",
      () => idleBoundaryProgram
    );
    it.effect(
      "ends an idle session that never recorded a terminal Turn",
      () => idleBoundaryWithoutTerminalTurnProgram
    );
    it.effect(
      "ends an idle session whose Pending Turn was abandoned before the boundary",
      () => idleBoundaryWithAbandonedPendingTurnProgram
    );
    it.effect(
      "continues a long-opened session whose Pending Turn is recent activity",
      () => idleBoundaryFromPendingTurnActivityProgram
    );
    it.effect(
      "continues an active session after a terms revision supersedes its basis",
      () => staleTermsKeepActiveSessionProgram
    );
    it.effect(
      "requires current Consent for the first session after the idle boundary",
      () => idleBoundaryRequiresCurrentConsentProgram
    );
    it.effect(
      "captures the exact onboarding Consent basis when it admits a session",
      () => consentBasisCaptureProgram
    );
    it.effect(
      "retains a Pending Turn when Consent revocation closes its session",
      () => pendingTurnSurvivesRevocationProgram
    );
    it.effect(
      "admits a fresh session after revocation and a later re-grant",
      () => revokedSessionReadmissionProgram
    );
    it.effect(
      "closes an active session when the User's latest onboarding grant is revoked",
      () => revokedLatestGrantClosesSessionProgram
    );
    it.effect(
      "refuses admission on a revoked latest grant despite an earlier unrevoked one",
      () => revokedLatestGrantRefusesAdmissionProgram
    );
    it.effect(
      "recovers after clock rollback without preceding persisted Turn evidence",
      () => recoveryTimestampProgram
    );
    it.effect(
      "refuses append and terminalization for a Turn that is no longer Pending",
      () => durableTerminalizationProgram
    );
    it.effect("persists fixed failure evidence outside model input", () => fixedFailureProgram);
    it.effect("round-trips every canonical outcome variant exactly", () => outcomeRoundTripProgram);
    it.effect(
      "round-trips maximum multibyte text and every maximum tool outcome exactly",
      () => maximumPayloadProgram
    );
    it.effect.prop(
      "round-trips schema-generated semantic content through PostgreSQL exactly",
      [TranscriptContentEntry],
      ([entry]) => generatedContentProgram(entry),
      { timeout: 30_000, fastCheck: { numRuns: 40 } }
    );
    it.effect(
      "rejects malformed request content with a content-free defect",
      () => malformedRequestProgram
    );
    it.effect(
      "allows corrected continuation content after safe rejection",
      () => malformedContinuationProgram
    );
    it.effect(
      "allows corrected assistant content after safe rejection",
      () => malformedAssistantProgram
    );
    it.effect(
      "allows a corrected failure reason after safe rejection",
      () => malformedFailureProgram
    );
    it.effect(
      "hides malformed persisted content and rolls back failed recovery",
      () => malformedPersistedEntryProgram
    );
    it.effect(
      "isolates preparation recovery observation and terminalization by User",
      () => userIsolationProgram
    );
  }
);
