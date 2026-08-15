import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import {
  Array as Arr,
  Cause,
  Context,
  Crypto,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { expectTypeOf } from "vitest";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import {
  AgentIteration,
  type AssistantTranscriptEntry,
  type CanonicalToolEvidence,
  type CanonicalToolOutcome,
  ToolCallId,
  TranscriptContentEntry,
  type TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  type TurnContinuationEntry,
  type TurnFailureReason,
  type UserTranscriptEntry,
} from "~/core/transcript/model";
import { projectTranscriptForModel } from "~/shell/agent/model-boundary";
import { currentDisclosure } from "~/shell/consent/current-disclosure";
import { appendConsentRecord } from "~/shell/consent/repo";
import { advisoryLockKey } from "~/shell/db/advisory-lock";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import { ConversationCompactionInference } from "./conversation-compaction-inference";
import {
  type ActiveTurnRequest,
  ContinuityChanged,
  type ContinuityView,
  ConversationCompactionPolicy,
  ConversationCompactionTokenCount,
  ConversationContinuity,
  type ConversationContinuityService,
  type DeliveredAssistantContent,
  type PendingTurn,
  type PreparedAttempt,
  type SerializedAttempt,
  type TurnContinuationContent,
} from "./conversation-continuity";

type ExpectedActiveTurnRequest = Pick<UserTranscriptEntry, "text">;
type WithoutContinuityMetadata<Entry> = Entry extends unknown
  ? Omit<Entry, "id" | "turnId" | "occurredAt">
  : never;
type ExpectedContinuationContent = WithoutContinuityMetadata<TurnContinuationEntry>;
type ExpectedAssistantContent = Pick<AssistantTranscriptEntry, "iteration" | "text">;

expectTypeOf<ActiveTurnRequest>().toEqualTypeOf<ExpectedActiveTurnRequest>();
expectTypeOf<TurnContinuationContent>().toEqualTypeOf<ExpectedContinuationContent>();
expectTypeOf<DeliveredAssistantContent>().toEqualTypeOf<ExpectedAssistantContent>();
expectTypeOf<keyof SerializedAttempt>().toEqualTypeOf<"prepare">();
expectTypeOf<keyof PreparedAttempt>().toEqualTypeOf<"context" | "begin">();
expectTypeOf<keyof PendingTurn>().toEqualTypeOf<"append" | "complete" | "fail">();
expectTypeOf<
  Effect.Error<ReturnType<PreparedAttempt["begin"]>>
>().toEqualTypeOf<ContinuityChanged>();
expectTypeOf<Effect.Error<ReturnType<PendingTurn["append"]>>>().toEqualTypeOf<never>();
expectTypeOf<Effect.Error<ReturnType<PendingTurn["complete"]>>>().toEqualTypeOf<never>();
expectTypeOf<Effect.Error<ReturnType<PendingTurn["fail"]>>>().toEqualTypeOf<never>();

type CryptoRaceGate = {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

type CompactionGate = {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly afterGeneration: Option.Option<Effect.Effect<void>>;
};

class CompactionRaceControl extends Context.Service<
  CompactionRaceControl,
  {
    readonly arm: (afterGeneration?: Effect.Effect<void>) => Effect.Effect<CompactionGate>;
  }
>()("@fidy/server/shell/transcript/conversation-continuity.test/CompactionRaceControl") {}

class CryptoRaceControl extends Context.Service<
  CryptoRaceControl,
  { readonly arm: Effect.Effect<CryptoRaceGate> }
>()("@fidy/server/shell/transcript/conversation-continuity.test/CryptoRaceControl") {}

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
    const arm = (afterGeneration?: Effect.Effect<void>): Effect.Effect<CompactionGate> =>
      Effect.gen(function* () {
        const gate: CompactionGate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
          afterGeneration: Option.fromNullishOr(afterGeneration),
        };
        yield* Ref.set(nextGate, Option.some(gate));
        return gate;
      });
    return Context.empty().pipe(
      Context.add(CompactionRaceControl, { arm }),
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
                  Deferred.succeed(gate.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                    Effect.andThen(Option.getOrElse(gate.afterGeneration, () => Effect.void)),
                    Effect.as({ compactedConversation: "resumen fiel" })
                  ),
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

const assertContentFreeDefect = (exit: Exit.Exit<unknown, unknown>, secret: string): void => {
  assertDefect(exit);
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain(secret);
};

const resetDefaultContinuity = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM transcript_entries WHERE user_id = ${defaultUserId}`;
  yield* sql`DELETE FROM conversation_continuity WHERE user_id = ${defaultUserId}`;
});

const isolatedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000004b0");
const resetIsolatedUser = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
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

const generatedMetadataProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const request = activeRequest("Necesito ayuda");
  const call = toolCallContent("generated");
  const result = toolResultContent(
    { _tag: "Succeeded", output: { retained: ["sí", 1, true] } },
    "generated"
  );

  yield* continuity.withSerializedAttempt(defaultUserId, request, (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        expect(yield* continuity.observe(defaultUserId)).toEqual({ entries: [], turns: [] });
        const pending = yield* prepared.begin();
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
    )
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
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("stale request must stay absent"),
    (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          yield* migrationSql`
            UPDATE conversation_continuity
            SET revision = revision + 1
            WHERE user_id = ${defaultUserId}
          `;
          const changed = yield* prepared.begin().pipe(Effect.flip);
          assert.deepStrictEqual(changed, new ContinuityChanged());
        })
      )
  );
  expect((yield* continuity.observe(defaultUserId)).entries).toEqual([]);
});

const staleMemoryPreparedProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const migrationSql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("stale memory request must stay absent"),
    (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          yield* migrationSql`
            INSERT INTO memory_revisions (user_id, revision)
            VALUES (${defaultUserId}, 1)
            ON CONFLICT (user_id) DO UPDATE
            SET revision = memory_revisions.revision + 1
          `;
          const changed = yield* prepared.begin().pipe(Effect.flip);
          assert.deepStrictEqual(changed, new ContinuityChanged());
        })
      )
  );
  expect((yield* continuity.observe(defaultUserId)).entries).toEqual([]);
});

const prepareAndInspectRecovery = (
  continuity: ConversationContinuityService,
  expectedCall: TurnContinuationContent
): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("next request"), (attempt) =>
    attempt.prepare(() =>
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
    )
  );

const assertSingleInterruption = (continuity: ConversationContinuityService): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("later request"), (attempt) =>
    attempt.prepare(() =>
      continuity
        .observe(defaultUserId)
        .pipe(
          Effect.map((view) =>
            expect(
              view.entries.filter((entry) => entry._tag === "InterruptedTurnTranscriptEntry")
            ).toHaveLength(1)
          )
        )
    )
  );

const recoveryProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  let escapedPending = Option.none<PendingTurn>();
  const call = toolCallContent("recovery");
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("recover me"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        escapedPending = Option.some(yield* prepared.begin());
        yield* Option.getOrThrow(escapedPending).append([call]);
      })
    )
  );
  expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
  yield* prepareAndInspectRecovery(continuity, call);
  yield* assertSingleInterruption(continuity);
  const pending = Option.getOrThrow(escapedPending);
  assertDefect(yield* pending.append([toolCallContent("escaped")]).pipe(Effect.exit));
});

const recoveryTimestampProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const sql = yield* MigrationSqlClient;
  yield* resetDefaultContinuity;
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("recover chronology"),
    (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          const pending = yield* prepared.begin();
          yield* pending.append([toolCallContent("future")]);
        })
      )
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
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("next request"), (attempt) =>
    attempt.prepare(assertRecoveryTime)
  );
});

const captureScopedCapabilities = (
  continuity: ConversationContinuityService,
  setAttempt: (attempt: SerializedAttempt) => void,
  setPrepared: (attempt: PreparedAttempt) => void
): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("scoped"), (attempt) => {
    setAttempt(attempt);
    return attempt.prepare((prepared) => {
      setPrepared(prepared);
      return Effect.void;
    });
  });

const assertSupersededPreparation = (
  continuity: ConversationContinuityService
): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("superseded"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        yield* attempt.prepare(() => Effect.void);
        assertDefect(yield* prepared.begin().pipe(Effect.exit));
      })
    )
  );

const terminalizeAndReuse = (
  continuity: ConversationContinuityService
): Effect.Effect<PendingTurn, ContinuityChanged> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("terminal"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        yield* pending.complete(assistantContent("done"));
        assertDefect(yield* pending.fail("DeliveryFailed").pipe(Effect.exit));
        return pending;
      })
    )
  );

const capabilityDefectsProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  let escapedSerialized = Option.none<SerializedAttempt>();
  let escapedPrepared = Option.none<PreparedAttempt>();
  yield* captureScopedCapabilities(
    continuity,
    (attempt) => {
      escapedSerialized = Option.some(attempt);
    },
    (prepared) => {
      escapedPrepared = Option.some(prepared);
    }
  );
  assertDefect(
    yield* Option.getOrThrow(escapedSerialized)
      .prepare(() => Effect.void)
      .pipe(Effect.exit)
  );
  assertDefect(yield* Option.getOrThrow(escapedPrepared).begin().pipe(Effect.exit));
  yield* assertSupersededPreparation(continuity);
  const terminalPending = yield* terminalizeAndReuse(continuity);
  assertDefect(yield* terminalPending.append([toolCallContent("after-scope")]).pipe(Effect.exit));
  expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(2);
});

type PendingRaceOperation = "append" | "complete" | "fail";

const pendingRaceOperation = (
  pending: PendingTurn,
  operation: PendingRaceOperation
): Effect.Effect<void> => {
  switch (operation) {
    case "append":
      return pending.append([toolCallContent("superseded-race")]);
    case "complete":
      return pending.complete(assistantContent("superseded-race"));
    case "fail":
      return pending.fail("DeliveryFailed");
  }
};

const raceAdmission = (
  race: CryptoRaceControl["Service"],
  attempt: SerializedAttempt,
  prepared: PreparedAttempt
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const gate = yield* race.arm;
    const admission = yield* Effect.forkChild(prepared.begin());
    yield* Deferred.await(gate.entered);
    yield* attempt.prepare(() => Effect.void);
    yield* Deferred.succeed(gate.release, undefined);
    assertDefect(yield* Fiber.await(admission));
  });

const supersedeDuringBeginProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  const race = yield* CryptoRaceControl;
  yield* resetDefaultContinuity;
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("racing begin"), (attempt) =>
    attempt.prepare((prepared) => raceAdmission(race, attempt, prepared))
  );
  expect(yield* continuity.observe(defaultUserId)).toEqual({ entries: [], turns: [] });
});

type PendingMutationRace = {
  readonly continuity: ConversationContinuityService;
  readonly race: CryptoRaceControl["Service"];
  readonly attempt: SerializedAttempt;
  readonly prepared: PreparedAttempt;
  readonly operation: PendingRaceOperation;
};

const racePendingMutation = ({
  continuity,
  race,
  attempt,
  prepared,
  operation,
}: PendingMutationRace): Effect.Effect<void, ContinuityChanged> =>
  Effect.gen(function* () {
    const pending = yield* prepared.begin();
    const admitted = yield* continuity.observe(defaultUserId);
    const gate = yield* race.arm;
    const mutation = yield* Effect.forkChild(pendingRaceOperation(pending, operation));
    yield* Deferred.await(gate.entered);
    yield* attempt.prepare(() => Effect.void);
    yield* Deferred.succeed(gate.release, undefined);
    assertDefect(yield* Fiber.await(mutation));
    const after = yield* continuity.observe(defaultUserId);
    expect(after.entries.map(withoutMetadata)).toEqual([
      ...admitted.entries.map(withoutMetadata),
      { _tag: "InterruptedTurnTranscriptEntry" },
    ]);
    expect(after.turns[0]?._tag).toBe("Interrupted");
  });

const supersedeDuringPendingMutationProgram = (
  operation: PendingRaceOperation
): Effect.Effect<
  void,
  ContinuityChanged | SqlError.SqlError,
  ConversationContinuity | CryptoRaceControl | MigrationSqlClient
> =>
  Effect.gen(function* () {
    const continuity = yield* ConversationContinuity;
    const race = yield* CryptoRaceControl;
    yield* resetDefaultContinuity;
    yield* continuity.withSerializedAttempt(
      defaultUserId,
      activeRequest(`racing ${operation}`),
      (attempt) =>
        attempt.prepare((prepared) =>
          racePendingMutation({ continuity, race, attempt, prepared, operation })
        )
    );
  });

const fixedFailureProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("fail safely"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        yield* pending.fail("HostedInferenceTimedOut");
      })
    )
  );
  const failed = yield* continuity.observe(defaultUserId);
  expect(failed.turns[0]).toMatchObject({
    _tag: "Failed",
    reason: "HostedInferenceTimedOut",
  });
  expect(failed.entries.map(withoutMetadata)).toEqual([
    { _tag: "UserTranscriptEntry", ...activeRequest("fail safely") },
    { _tag: "FailedTurnTranscriptEntry", reason: "HostedInferenceTimedOut" },
  ]);
  expect(projectTranscriptForModel(failed.entries, 1_000)).toEqual([failed.entries[0]]);
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
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("all outcomes"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        yield* pending.append(contents);
        yield* pending.complete(assistantContent("complete", 5));
      })
    )
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
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest(maximumText), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        yield* pending.append(contents);
        yield* pending.complete(assistantContent(maximumText, 5));
      })
    )
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
  ContinuityChanged | SqlError.SqlError,
  ConversationContinuity | MigrationSqlClient
> =>
  Effect.gen(function* () {
    const continuity = yield* ConversationContinuity;
    yield* resetDefaultContinuity;
    const request =
      entry._tag === "UserTranscriptEntry"
        ? { text: entry.text }
        : activeRequest("generated entry round-trip");
    yield* continuity.withSerializedAttempt(defaultUserId, request, (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          const pending = yield* prepared.begin();
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
      )
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
  const rejected = yield* continuity
    .withSerializedAttempt(defaultUserId, malformed, () => Effect.void)
    .pipe(Effect.exit);
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
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("continue safely"),
    (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          const pending = yield* prepared.begin();
          const rejected = yield* pending.append([malformed]).pipe(Effect.exit);
          assertContentFreeDefect(rejected, secret);
          expect((yield* continuity.observe(defaultUserId)).entries).toHaveLength(1);
          yield* pending.append([toolCallContent("corrected")]);
          yield* pending.complete(assistantContent("corrected"));
        })
      )
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
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("complete safely"),
    (attempt) =>
      attempt.prepare((prepared) =>
        Effect.gen(function* () {
          const pending = yield* prepared.begin();
          const rejected = yield* pending.complete(malformed).pipe(Effect.exit);
          assertContentFreeDefect(rejected, secret);
          expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
          yield* pending.complete(assistantContent("corrected"));
        })
      )
  );
  expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Completed");
});

const malformedFailureProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  const secret = "failure-reason-secret";
  const malformed = yield* Schema.decodeUnknownEffect(ForgedTurnFailureReason)(secret);
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("fail safely"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        const rejected = yield* pending.fail(malformed).pipe(Effect.exit);
        assertContentFreeDefect(rejected, secret);
        expect((yield* continuity.observe(defaultUserId)).turns[0]?._tag).toBe("Pending");
        yield* pending.fail("DeliveryFailed");
      })
    )
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
  yield* continuity.withSerializedAttempt(
    defaultUserId,
    activeRequest("persisted secret"),
    (attempt) => attempt.prepare((prepared) => prepared.begin().pipe(Effect.asVoid))
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

  const prepared = yield* continuity
    .withSerializedAttempt(defaultUserId, activeRequest("must roll back recovery"), (attempt) =>
      attempt.prepare(() => Effect.void)
    )
    .pipe(Effect.exit);
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
): Effect.Effect<void, ContinuityChanged> =>
  continuity.withSerializedAttempt(userId, request, (attempt) =>
    attempt.prepare((prepared) => prepared.begin().pipe(Effect.asVoid))
  );

const completeIsolatedTurn = (
  continuity: ConversationContinuityService
): Effect.Effect<void, ContinuityChanged> =>
  continuity.withSerializedAttempt(isolatedUserId, activeRequest("second user"), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        expect(yield* continuity.observe(isolatedUserId)).toEqual({ entries: [], turns: [] });
        const pending = yield* prepared.begin();
        yield* pending.complete(assistantContent("second complete"));
      })
    )
  );

const recoverFirstUser = (continuity: ConversationContinuityService): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("recover first"), (attempt) =>
    attempt.prepare(() =>
      continuity
        .observe(defaultUserId)
        .pipe(Effect.map((view) => expect(view.turns[0]?._tag).toBe("Interrupted")))
    )
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

const capturePrepared = (
  continuity: ConversationContinuityService,
  setPrepared: (prepared: PreparedAttempt) => void
): Effect.Effect<void> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest("original"), (attempt) =>
    attempt.prepare((prepared) => {
      setPrepared(prepared);
      return Effect.void;
    })
  );

const prepareWithRebuiltModule = Effect.gen(function* () {
  const rebuiltContext = yield* Layer.build(Layer.fresh(ConversationContinuity.layer));
  const rebuilt = Context.get(rebuiltContext, ConversationContinuity);
  yield* rebuilt.withSerializedAttempt(defaultUserId, activeRequest("rebuilt"), (attempt) =>
    attempt.prepare(() =>
      rebuilt
        .observe(defaultUserId)
        .pipe(Effect.map((view) => expect(view).toEqual({ entries: [], turns: [] })))
    )
  );
});

const FreshConversationContinuityRuntime = ConversationContinuity.layer.pipe(
  Layer.provide(Layer.fresh(PgLive))
);

const makeFreshContinuity = Layer.build(Layer.fresh(FreshConversationContinuityRuntime)).pipe(
  Effect.map((services) => Context.get(services, ConversationContinuity))
);

const awaitHostedAttemptWaiter = (userId: UserId): Effect.Effect<void, never, MigrationSqlClient> =>
  Effect.gen(function* () {
    const migrationSql = yield* MigrationSqlClient;
    const lockKey = advisoryLockKey.hostedAttempt(userId);
    const waiters = yield* migrationSql<{ readonly present: number }>`
      SELECT 1 AS present
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND objsubid = 1
        AND classid = (
          (hashtextextended(${lockKey.value}, ${lockKey.seed}) >> 32) & 4294967295
        )::oid
        AND objid = (
          hashtextextended(${lockKey.value}, ${lockKey.seed}) & 4294967295
        )::oid
      LIMIT 1
    `;
    if (waiters.length === 0) {
      return yield* Effect.fail(undefined);
    }
  }).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 100 }), Effect.orDie);

type HeldAttempt = {
  readonly continuity: ConversationContinuityService;
  readonly userId: UserId;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

const holdSerializedAttempt = ({
  continuity,
  userId,
  entered,
  release,
}: HeldAttempt): Effect.Effect<void> =>
  continuity.withSerializedAttempt(userId, activeRequest("hosted work"), () =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  );

const sameUserSerializationProgram = Effect.scoped(
  Effect.gen(function* () {
    const firstContinuity = yield* makeFreshContinuity;
    const secondContinuity = yield* makeFreshContinuity;
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const releaseSecond = yield* Deferred.make<void>();

    const first = yield* holdSerializedAttempt({
      continuity: firstContinuity,
      userId: defaultUserId,
      entered: firstEntered,
      release: releaseFirst,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    const second = yield* holdSerializedAttempt({
      continuity: secondContinuity,
      userId: defaultUserId,
      entered: secondEntered,
      release: releaseSecond,
    }).pipe(Effect.forkChild);

    yield* awaitHostedAttemptWaiter(defaultUserId);
    expect(yield* Deferred.isDone(secondEntered)).toBe(false);
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(secondEntered);
    yield* Deferred.succeed(releaseSecond, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  })
);

const crossUserConcurrencyProgram = Effect.scoped(
  Effect.gen(function* () {
    const firstContinuity = yield* makeFreshContinuity;
    const secondContinuity = yield* makeFreshContinuity;
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();

    const first = yield* holdSerializedAttempt({
      continuity: firstContinuity,
      userId: defaultUserId,
      entered: firstEntered,
      release,
    }).pipe(Effect.forkChild);
    const second = yield* holdSerializedAttempt({
      continuity: secondContinuity,
      userId: isolatedUserId,
      entered: secondEntered,
      release,
    }).pipe(Effect.forkChild);

    yield* Deferred.await(firstEntered);
    yield* Deferred.await(secondEntered);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  })
);

const noLongTransactionProgram = Effect.scoped(
  Effect.gen(function* () {
    const continuity = yield* makeFreshContinuity;
    const migrationSql = yield* MigrationSqlClient;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* holdSerializedAttempt({
      continuity,
      userId: defaultUserId,
      entered,
      release,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);

    const lockKey = advisoryLockKey.hostedAttempt(defaultUserId);
    const rows = yield* migrationSql<{
      readonly state: string;
      readonly hasNoTransaction: boolean;
    }>`
      SELECT
        activity.state,
        activity.xact_start IS NULL AS "hasNoTransaction"
      FROM pg_locks AS lock
      JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory'
        AND lock.granted
        AND lock.objsubid = 1
        AND lock.classid = (
          (hashtextextended(${lockKey.value}, ${lockKey.seed}) >> 32) & 4294967295
        )::oid
        AND lock.objid = (
          hashtextextended(${lockKey.value}, ${lockKey.seed}) & 4294967295
        )::oid
    `;
    expect(rows).toEqual([{ state: "idle", hasNoTransaction: true }]);
    yield* migrationSql`SELECT 1`;

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
  })
);

class ExpectedAttemptFailure extends Data.TaggedError("ExpectedAttemptFailure")<{}> {}

const assertFreshAttemptCanEnter = Effect.fnUntraced(function* () {
  const continuity = yield* makeFreshContinuity;
  let entered = false;
  yield* continuity.withSerializedAttempt(defaultUserId, activeRequest("next attempt"), () =>
    Effect.sync(() => {
      entered = true;
    })
  );
  expect(entered).toBe(true);
});

const releaseMatrixProgram = Effect.scoped(
  Effect.gen(function* () {
    const success = yield* makeFreshContinuity;
    yield* success.withSerializedAttempt(
      defaultUserId,
      activeRequest("success"),
      () => Effect.void
    );
    yield* assertFreshAttemptCanEnter();

    const typedFailure = yield* makeFreshContinuity;
    const failed = yield* typedFailure
      .withSerializedAttempt(defaultUserId, activeRequest("typed failure"), () =>
        Effect.fail(new ExpectedAttemptFailure())
      )
      .pipe(Effect.exit);
    expect(Exit.isFailure(failed)).toBe(true);
    yield* assertFreshAttemptCanEnter();

    const defective = yield* makeFreshContinuity;
    assertDefect(
      yield* defective
        .withSerializedAttempt(defaultUserId, activeRequest("defect"), () =>
          Effect.die("expected hosted-attempt defect")
        )
        .pipe(Effect.exit)
    );
    yield* assertFreshAttemptCanEnter();

    const throwing = yield* makeFreshContinuity;
    let escaped = Option.none<SerializedAttempt>();
    assertDefect(
      yield* throwing
        .withSerializedAttempt(
          defaultUserId,
          activeRequest("synchronous defect"),
          (attempt): Effect.Effect<never> => {
            escaped = Option.some(attempt);
            throw new Error("expected synchronous hosted-attempt defect");
          }
        )
        .pipe(Effect.exit)
    );
    assertDefect(
      yield* Option.getOrThrow(escaped)
        .prepare(() => Effect.void)
        .pipe(Effect.exit)
    );
    yield* assertFreshAttemptCanEnter();

    const interrupted = yield* makeFreshContinuity;
    const entered = yield* Deferred.make<void>();
    const fiber = yield* interrupted
      .withSerializedAttempt(defaultUserId, activeRequest("interrupted"), () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    yield* assertFreshAttemptCanEnter();
  })
);

const waitingCancellationProgram = Effect.scoped(
  Effect.gen(function* () {
    const holderContinuity = yield* makeFreshContinuity;
    const waitingContinuity = yield* makeFreshContinuity;
    const holderEntered = yield* Deferred.make<void>();
    const releaseHolder = yield* Deferred.make<void>();
    const waitingEntered = yield* Deferred.make<void>();

    const holder = yield* holdSerializedAttempt({
      continuity: holderContinuity,
      userId: defaultUserId,
      entered: holderEntered,
      release: releaseHolder,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(holderEntered);
    const waiter = yield* waitingContinuity
      .withSerializedAttempt(defaultUserId, activeRequest("cancelled waiter"), () =>
        Deferred.succeed(waitingEntered, undefined)
      )
      .pipe(Effect.forkChild);
    yield* awaitHostedAttemptWaiter(defaultUserId);
    expect(yield* Deferred.isDone(waitingEntered)).toBe(false);

    yield* Effect.all([Fiber.interrupt(waiter), Deferred.succeed(releaseHolder, undefined)], {
      concurrency: "unbounded",
    });
    yield* Fiber.join(holder);
    yield* assertFreshAttemptCanEnter();
  })
);

const moduleInstanceProgram = Effect.gen(function* () {
  const continuity = yield* ConversationContinuity;
  yield* resetDefaultContinuity;
  let escaped = Option.none<PreparedAttempt>();
  yield* capturePrepared(continuity, (prepared) => {
    escaped = Option.some(prepared);
  });
  yield* Effect.scoped(prepareWithRebuiltModule);
  assertDefect(yield* Option.getOrThrow(escaped).begin().pipe(Effect.exit));
});

const completeTestTurn = (
  continuity: ConversationContinuityService,
  text: string
): Effect.Effect<void, ContinuityChanged> =>
  continuity.withSerializedAttempt(defaultUserId, activeRequest(text), (attempt) =>
    attempt.prepare((prepared) =>
      Effect.gen(function* () {
        const pending = yield* prepared.begin();
        yield* pending.complete(assistantContent());
      })
    )
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
                })
              );
              yield* appendConsentRecord(
                ConsentRecord.make({
                  id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000004fd"),
                  subjectUserId: defaultUserId,
                  event: { _tag: "Granted", grant: { _tag: "Onboarding" } },
                  disclosure,
                  occurredAt: DateTime.makeUnsafe("2026-08-13T12:00:01Z"),
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
                })
              );
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            const gate = yield* control.arm(mutateConsent);
            const compacting = yield* completeTestTurn(continuity, "tercero").pipe(
              Effect.forkChild
            );
            yield* Deferred.await(gate.entered);
            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(compacting);

            expect(
              yield* sql`
              SELECT text FROM compacted_conversations WHERE user_id = ${defaultUserId}
            `
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
      "recovers after clock rollback without preceding persisted Turn evidence",
      () => recoveryTimestampProgram
    );
    it.effect(
      "rejects escaped superseded and terminal capabilities as defects",
      () => capabilityDefectsProgram
    );
    it.effect(
      "prevents a superseded attempt from admitting after asynchronous preparation",
      () => supersedeDuringBeginProgram
    );
    for (const operation of ["append", "complete", "fail"] as const) {
      it.effect(
        `prevents a superseded attempt from committing ${operation} after asynchronous preparation`,
        () => supersedeDuringPendingMutationProgram(operation)
      );
    }
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
    it.effect(
      "serializes the same User across fresh module instances",
      () => sameUserSerializationProgram
    );
    it.effect(
      "allows different Users to overlap across fresh module instances",
      () => crossUserConcurrencyProgram
    );
    it.effect("holds the session lock without an open transaction", () => noLongTransactionProgram);
    it.effect(
      "releases serialization after success, typed failure, defect, and interruption",
      () => releaseMatrixProgram
    );
    it.effect(
      "cancels an advisory-lock wait without entering or poisoning the next attempt",
      () => waitingCancellationProgram
    );
    it.effect(
      "keeps capabilities bound to their creating module instance",
      () => moduleInstanceProgram
    );
  }
);
