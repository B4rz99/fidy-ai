import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UserId } from "~/core/identity/reference";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  type CanonicalToolOutcome,
  CanonicalToolResultEntry,
  ToolCallId,
  TranscriptContentEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  type TurnContinuationEntry,
  type TurnFailureReason,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { projectTranscriptForModel } from "~/shell/agent/model-boundary";
import { MigrationSqlClient } from "~/shell/db/client";
import { defaultUserId } from "~/shell/db/development-seed";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  ContinuityAuthorityRejected,
  ContinuityChanged,
  ConversationContinuity,
  InvalidTerminalTimestamp,
  InvalidTranscriptEntry,
  InvalidTurnFailureReason,
  type PreparedContinuity,
  TurnAlreadyTerminal,
  TurnAuthorityRejected,
} from "./conversation-continuity";

const ContinuityHarness = ConversationContinuity.layer.pipe(Layer.provideMerge(ApiHarness));
const ForgedPreparedContinuity = Schema.declare(
  (input): input is PreparedContinuity => typeof input === "object" && input !== null
);
const ForgedTurnContinuationEntry = Schema.declare(
  (input): input is TurnContinuationEntry => typeof input === "object" && input !== null
);
const ForgedUserTranscriptEntry = Schema.declare(
  (input): input is UserTranscriptEntry => typeof input === "object" && input !== null
);
const ForgedAssistantTranscriptEntry = Schema.declare(
  (input): input is AssistantTranscriptEntry => typeof input === "object" && input !== null
);
const ForgedTurnFailureReason = Schema.declare(
  (input): input is TurnFailureReason => typeof input === "string"
);

const makeUserEntry = (
  overrides: Partial<Omit<UserTranscriptEntry, "_tag">> = {}
): UserTranscriptEntry =>
  UserTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000400"),
    turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000401"),
    text: TranscriptText.make("Necesito ayuda"),
    occurredAt: DateTime.makeUnsafe("2026-08-11T12:00:00Z"),
    ...overrides,
  });

const makeAssistantEntry = (
  overrides: Partial<Omit<AssistantTranscriptEntry, "_tag">> = {}
): AssistantTranscriptEntry =>
  AssistantTranscriptEntry.make({
    id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000403"),
    turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000401"),
    text: TranscriptText.make("Claro"),
    iteration: AgentIteration.make(1),
    occurredAt: DateTime.makeUnsafe("2026-08-11T12:00:01Z"),
    ...overrides,
  });

const assertFailure = (actual: Exit.Exit<unknown, unknown>, expected: unknown): void => {
  const withoutRuntimeTrace = Exit.match(actual, {
    onFailure: (cause) =>
      Exit.failCause(
        Cause.fromReasons(
          cause.reasons.map((reason) => {
            switch (reason._tag) {
              case "Die":
                return Cause.makeDieReason(reason.defect);
              case "Fail":
                return Cause.makeFailReason(reason.error);
              case "Interrupt":
                return Cause.makeInterruptReason(reason.fiberId);
            }
            throw new Error("Unexpected Cause reason.");
          })
        )
      ),
    onSuccess: Exit.succeed,
  });
  assert.deepStrictEqual(withoutRuntimeTrace, Exit.fail(expected));
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

layer(ContinuityHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ConversationContinuity",
  (it) => {
    it.effect("persists exact entries and an explicit Pending to Completed Turn", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000401");
        const startedAt = DateTime.makeUnsafe("2026-08-11T12:00:00Z");
        const userEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000402"),
          turnId,
          occurredAt: startedAt,
        });
        const assistantEntry = makeAssistantEntry({ turnId });

        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const handle = yield* continuity.beginTurn(defaultUserId, prepared, userEntry);
        const pending = yield* continuity.observe(defaultUserId);
        expect(pending.turns).toEqual([{ _tag: "Pending", id: turnId, startedAt }]);
        expect(pending.entries).toEqual([userEntry]);

        yield* continuity.completeTurn(defaultUserId, handle, {
          entry: assistantEntry,
          terminalAt: DateTime.makeUnsafe("2026-08-11T12:00:02Z"),
        });
        const completed = yield* continuity.observe(defaultUserId);
        expect(completed.turns[0]).toMatchObject({ _tag: "Completed", id: turnId });
        expect(completed.entries).toEqual([userEntry, assistantEntry]);
      })
    );

    it.effect("rejects foreign, forged, and stale preparation without appending", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const startedAt = DateTime.makeUnsafe("2026-08-11T13:00:00Z");
        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const rebuiltContext = yield* Effect.scoped(
          Layer.build(Layer.fresh(ConversationContinuity.layer))
        );
        const rebuilt = Context.get(rebuiltContext, ConversationContinuity);
        const rebuiltSnapshotFailure = yield* rebuilt
          .beginTurn(
            defaultUserId,
            prepared,
            makeUserEntry({
              id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000410"),
              turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000409"),
              text: TranscriptText.make("rebuilt"),
              occurredAt: startedAt,
            })
          )
          .pipe(Effect.exit);
        assertFailure(
          rebuiltSnapshotFailure,
          new ContinuityAuthorityRejected({ reason: "Forged" })
        );
        const winningPrepared = yield* continuity.prepareForTurn(defaultUserId);
        const winningEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000412"),
          turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000411"),
          text: TranscriptText.make("winner"),
          occurredAt: startedAt,
        });
        yield* continuity.beginTurn(defaultUserId, winningPrepared, winningEntry);
        const preparationReuse = yield* continuity
          .beginTurn(defaultUserId, winningPrepared, winningEntry)
          .pipe(Effect.exit);
        assertFailure(preparationReuse, new ContinuityAuthorityRejected({ reason: "Consumed" }));
        const losingEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000414"),
          turnId: TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000413"),
          text: TranscriptText.make("loser"),
          occurredAt: startedAt,
        });

        const foreign = yield* continuity
          .beginTurn(UserId.make("f1d1a000-0000-4000-8000-000000000499"), prepared, losingEntry)
          .pipe(Effect.exit);
        assertFailure(foreign, new ContinuityAuthorityRejected({ reason: "Foreign" }));
        const forgedPrepared = yield* Schema.decodeUnknownEffect(ForgedPreparedContinuity)({
          entries: [],
          turns: [],
        });
        const forged = yield* continuity
          .beginTurn(defaultUserId, forgedPrepared, losingEntry)
          .pipe(Effect.exit);
        assertFailure(forged, new ContinuityAuthorityRejected({ reason: "Forged" }));
        const stale = yield* continuity
          .beginTurn(defaultUserId, prepared, losingEntry)
          .pipe(Effect.exit);
        assertFailure(stale, new ContinuityChanged());
        const reusedStale = yield* continuity
          .beginTurn(defaultUserId, prepared, losingEntry)
          .pipe(Effect.exit);
        assertFailure(reusedStale, new ContinuityAuthorityRejected({ reason: "Consumed" }));

        const observed = yield* continuity.observe(defaultUserId);
        expect(observed.entries).toEqual([winningEntry]);
      })
    );

    it.effect(
      "persists fixed failure evidence outside model input, validates time, and consumes handles",
      () =>
        Effect.gen(function* () {
          const continuity = yield* ConversationContinuity;
          yield* resetDefaultContinuity;
          const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000421");
          const startedAt = DateTime.makeUnsafe("2026-08-11T14:00:00Z");
          const userEntry = makeUserEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000422"),
            turnId,
            text: TranscriptText.make("fail safely"),
            occurredAt: startedAt,
          });
          const prepared = yield* continuity.prepareForTurn(defaultUserId);
          const invalidUserEntry = yield* Schema.decodeUnknownEffect(ForgedUserTranscriptEntry)({
            ...userEntry,
            text: "invalid\u0000text",
          });
          const invalidUserFailure = yield* continuity
            .beginTurn(defaultUserId, prepared, invalidUserEntry)
            .pipe(Effect.exit);
          assertFailure(invalidUserFailure, new InvalidTranscriptEntry());
          const handle = yield* continuity.beginTurn(defaultUserId, prepared, userEntry);

          const invalidTime = yield* continuity
            .failTurn(defaultUserId, handle, {
              reason: "HostedInferenceTimedOut",
              terminalAt: DateTime.makeUnsafe("2026-08-11T13:59:59Z"),
            })
            .pipe(Effect.exit);
          assertFailure(invalidTime, new InvalidTerminalTimestamp());

          const invalidEvidence = yield* Schema.decodeUnknownEffect(ForgedTurnContinuationEntry)({
            ...CanonicalToolCallEntry.make({
              id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000423"),
              turnId,
              iteration: AgentIteration.make(1),
              toolCallId: ToolCallId.make("invalid-evidence"),
              operation: CanonicalOperationId.make("categories.listCategories"),
              input: {},
              occurredAt: startedAt,
            }),
            input: { invalid: "\u0000" },
          });
          const invalidEvidenceFailure = yield* continuity
            .appendTurn(defaultUserId, handle, [invalidEvidence])
            .pipe(Effect.exit);
          assertFailure(invalidEvidenceFailure, new InvalidTranscriptEntry());

          const validAssistant = makeAssistantEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000424"),
            turnId,
            text: TranscriptText.make("not persisted"),
            occurredAt: startedAt,
          });
          const invalidAssistant = yield* Schema.decodeUnknownEffect(
            ForgedAssistantTranscriptEntry
          )({ ...validAssistant, text: "invalid\u0000text" });
          const invalidAssistantFailure = yield* continuity
            .completeTurn(defaultUserId, handle, {
              entry: invalidAssistant,
              terminalAt: DateTime.makeUnsafe("2026-08-11T14:00:01Z"),
            })
            .pipe(Effect.exit);
          assertFailure(invalidAssistantFailure, new InvalidTranscriptEntry());

          const invalidTimestampFailure = yield* continuity
            .completeTurn(defaultUserId, handle, {
              entry: validAssistant,
              terminalAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z"),
            })
            .pipe(Effect.exit);
          assertFailure(invalidTimestampFailure, new InvalidTerminalTimestamp());
          const invalidFailureTimestamp = yield* continuity
            .failTurn(defaultUserId, handle, {
              reason: "HostedInferenceFailed",
              terminalAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z"),
            })
            .pipe(Effect.exit);
          assertFailure(invalidFailureTimestamp, new InvalidTerminalTimestamp());
          const invalidReason =
            yield* Schema.decodeUnknownEffect(ForgedTurnFailureReason)("CallerProse");
          const invalidReasonFailure = yield* continuity
            .failTurn(defaultUserId, handle, {
              reason: invalidReason,
              terminalAt: DateTime.makeUnsafe("2026-08-11T14:00:01Z"),
            })
            .pipe(Effect.exit);
          assertFailure(invalidReasonFailure, new InvalidTurnFailureReason());

          const rebuiltContext = yield* Effect.scoped(
            Layer.build(Layer.fresh(ConversationContinuity.layer))
          );
          const rebuilt = Context.get(rebuiltContext, ConversationContinuity);
          const rebuiltHandleFailure = yield* rebuilt
            .appendTurn(defaultUserId, handle, [])
            .pipe(Effect.exit);
          assertFailure(rebuiltHandleFailure, new TurnAuthorityRejected({ reason: "Forged" }));

          yield* continuity.failTurn(defaultUserId, handle, {
            reason: "HostedInferenceTimedOut",
            terminalAt: DateTime.makeUnsafe("2026-08-11T14:00:01Z"),
          });
          const failed = yield* continuity.observe(defaultUserId);
          expect(failed.turns[0]).toMatchObject({
            _tag: "Failed",
            id: turnId,
            reason: "HostedInferenceTimedOut",
          });
          expect(failed.entries[0]).toEqual(userEntry);
          expect(failed.entries[1]).toMatchObject({
            _tag: "FailedTurnTranscriptEntry",
            turnId,
            reason: "HostedInferenceTimedOut",
          });
          expect(Object.keys(failed.entries[1] ?? {}).toSorted()).toEqual([
            "_tag",
            "id",
            "occurredAt",
            "reason",
            "turnId",
          ]);
          expect(projectTranscriptForModel(failed.entries, 1_000)).toEqual([userEntry]);

          const assistantEntry = makeAssistantEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000423"),
            turnId,
            text: TranscriptText.make("too late"),
            occurredAt: DateTime.makeUnsafe("2026-08-11T14:00:02Z"),
          });
          const reused = yield* continuity
            .completeTurn(defaultUserId, handle, {
              entry: assistantEntry,
              terminalAt: DateTime.makeUnsafe("2026-08-11T14:00:03Z"),
            })
            .pipe(Effect.exit);
          assertFailure(reused, new TurnAuthorityRejected({ reason: "Consumed" }));
        })
    );

    it.effect("rejects mismatched entries and permits completion after a corrected retry", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000425");
        const startedAt = DateTime.makeUnsafe("2026-08-11T14:30:00Z");
        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const handle = yield* continuity.beginTurn(
          defaultUserId,
          prepared,
          makeUserEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000426"),
            turnId,
            text: TranscriptText.make("correct me"),
            occurredAt: startedAt,
          })
        );
        const otherTurnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000427");
        const mismatchedCall = CanonicalToolCallEntry.make({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000428"),
          turnId: otherTurnId,
          iteration: AgentIteration.make(1),
          toolCallId: ToolCallId.make("mismatched"),
          operation: CanonicalOperationId.make("categories.listCategories"),
          input: {},
          occurredAt: startedAt,
        });
        const appendMismatch = yield* continuity
          .appendTurn(defaultUserId, handle, [mismatchedCall])
          .pipe(Effect.exit);
        assertFailure(appendMismatch, new TurnAuthorityRejected({ reason: "EntryTurnMismatch" }));

        const assistant = (entryTurnId: TranscriptTurnId): AssistantTranscriptEntry =>
          makeAssistantEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000429"),
            turnId: entryTurnId,
            text: TranscriptText.make("corrected"),
            occurredAt: DateTime.makeUnsafe("2026-08-11T14:30:01Z"),
          });
        const completionMismatch = yield* continuity
          .completeTurn(defaultUserId, handle, {
            entry: assistant(otherTurnId),
            terminalAt: DateTime.makeUnsafe("2026-08-11T14:30:02Z"),
          })
          .pipe(Effect.exit);
        assertFailure(
          completionMismatch,
          new TurnAuthorityRejected({ reason: "EntryTurnMismatch" })
        );
        const invalidTime = yield* continuity
          .completeTurn(defaultUserId, handle, {
            entry: assistant(turnId),
            terminalAt: DateTime.makeUnsafe("2026-08-11T14:29:59Z"),
          })
          .pipe(Effect.exit);
        assertFailure(invalidTime, new InvalidTerminalTimestamp());

        yield* continuity.completeTurn(defaultUserId, handle, {
          entry: assistant(turnId),
          terminalAt: DateTime.makeUnsafe("2026-08-11T14:30:02Z"),
        });
        const completed = yield* continuity.observe(defaultUserId);
        expect(completed.turns[0]).toMatchObject({ _tag: "Completed" });
        expect(completed.entries).toHaveLength(2);
      })
    );

    it.effect("recovers an abandoned Pending Turn exactly once as Interrupted", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000431");
        const startedAt = DateTime.makeUnsafe("2026-08-11T15:00:00Z");
        const userEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000432"),
          turnId,
          text: TranscriptText.make("recover me"),
          occurredAt: startedAt,
        });
        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const handle = yield* continuity.beginTurn(defaultUserId, prepared, userEntry);
        const operation = CanonicalOperationId.make("categories.listCategories");
        const call = CanonicalToolCallEntry.make({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000433"),
          turnId,
          iteration: AgentIteration.make(1),
          toolCallId: ToolCallId.make("recovery-call"),
          operation,
          input: { query: "exact" },
          occurredAt: DateTime.makeUnsafe("2026-08-11T15:00:01Z"),
        });
        const result = CanonicalToolResultEntry.make({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000434"),
          turnId,
          iteration: AgentIteration.make(1),
          toolCallId: ToolCallId.make("recovery-call"),
          operation,
          outcome: { _tag: "Succeeded", output: { retained: ["sí", 1, true] } },
          occurredAt: DateTime.makeUnsafe("2026-08-11T15:00:02Z"),
        });
        yield* continuity.appendTurn(defaultUserId, handle, [call, result]);

        const restartedContext = yield* Effect.scoped(
          Layer.build(Layer.fresh(ConversationContinuity.layer))
        );
        const restarted = Context.get(restartedContext, ConversationContinuity);
        const recovered = yield* restarted.prepareForTurn(defaultUserId);
        expect(recovered.turns[0]).toMatchObject({ _tag: "Interrupted", id: turnId });
        expect(recovered.entries.slice(0, 3)).toEqual([userEntry, call, result]);
        expect(recovered.entries[3]).toMatchObject({
          _tag: "InterruptedTurnTranscriptEntry",
          turnId,
        });
        expect(Object.keys(recovered.entries[3] ?? {}).toSorted()).toEqual([
          "_tag",
          "id",
          "occurredAt",
          "turnId",
        ]);

        const recoveredAgain = yield* restarted.prepareForTurn(defaultUserId);
        expect(recoveredAgain.entries).toEqual(recovered.entries);
        const abandonedHandle = yield* continuity
          .appendTurn(defaultUserId, handle, [])
          .pipe(Effect.exit);
        assertFailure(abandonedHandle, new TurnAlreadyTerminal());
      })
    );

    it.effect("round-trips every canonical outcome variant exactly", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000471");
        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const handle = yield* continuity.beginTurn(
          defaultUserId,
          prepared,
          makeUserEntry({
            id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000472"),
            turnId,
            text: TranscriptText.make("all outcomes"),
            occurredAt: DateTime.makeUnsafe("2026-08-11T16:40:00Z"),
          })
        );
        const outcomes: ReadonlyArray<CanonicalToolOutcome> = [
          { _tag: "Succeeded", output: { exact: "é" } },
          { _tag: "ToolInputRejected", failure: { code: "bad_input" } },
          { _tag: "ToolOutputRejected", failure: { code: "bad_output" } },
          { _tag: "CanonicalOperationFailed", failure: { code: "failed" } },
        ];
        const entries = outcomes.map((outcome, index) =>
          CanonicalToolResultEntry.make({
            id: TranscriptEntryId.make(
              `f1d1a000-0000-4000-8000-${String(473 + index).padStart(12, "0")}`
            ),
            turnId,
            iteration: AgentIteration.make(index + 1),
            toolCallId: ToolCallId.make(`outcome-${index}`),
            operation: CanonicalOperationId.make("categories.listCategories"),
            outcome,
            occurredAt: DateTime.makeUnsafe(`2026-08-11T16:40:0${index + 1}Z`),
          })
        );
        yield* continuity.appendTurn(defaultUserId, handle, entries);

        const observed = yield* continuity.observe(defaultUserId);
        expect(observed.entries.slice(1)).toEqual(entries);
      })
    );

    it.effect("round-trips maximum multibyte text and tool evidence exactly", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        const turnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000471");
        const userEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000472"),
          turnId,
          text: TranscriptText.make("é".repeat(16_000)),
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:45:00Z"),
        });
        const prepared = yield* continuity.prepareForTurn(defaultUserId);
        const handle = yield* continuity.beginTurn(defaultUserId, prepared, userEntry);
        const maximumEvidence = "é".repeat(499_999);
        const operation = CanonicalOperationId.make("categories.listCategories");
        const call = CanonicalToolCallEntry.make({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000473"),
          turnId,
          iteration: AgentIteration.make(1),
          toolCallId: ToolCallId.make("maximum-evidence-call"),
          operation,
          input: maximumEvidence,
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:45:01Z"),
        });
        const maximumOutcomes: ReadonlyArray<CanonicalToolOutcome> = [
          { _tag: "Succeeded", output: maximumEvidence },
          { _tag: "ToolInputRejected", failure: maximumEvidence },
          { _tag: "ToolOutputRejected", failure: maximumEvidence },
          { _tag: "CanonicalOperationFailed", failure: maximumEvidence },
        ];
        const results = maximumOutcomes.map((outcome, index) =>
          CanonicalToolResultEntry.make({
            id: TranscriptEntryId.make(
              `f1d1a000-0000-4000-8000-${String(474 + index).padStart(12, "0")}`
            ),
            turnId,
            iteration: AgentIteration.make(index + 1),
            toolCallId: ToolCallId.make(`maximum-evidence-result-${index}`),
            operation,
            outcome,
            occurredAt: DateTime.makeUnsafe(`2026-08-11T16:45:0${index + 2}Z`),
          })
        );
        yield* continuity.appendTurn(defaultUserId, handle, [call, ...results]);
        const assistantEntry = makeAssistantEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000478"),
          turnId,
          text: TranscriptText.make("é".repeat(16_000)),
          iteration: AgentIteration.make(5),
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:45:06Z"),
        });
        yield* continuity.completeTurn(defaultUserId, handle, {
          entry: assistantEntry,
          terminalAt: DateTime.makeUnsafe("2026-08-11T16:45:07Z"),
        });

        expect((yield* continuity.observe(defaultUserId)).entries).toEqual([
          userEntry,
          call,
          ...results,
          assistantEntry,
        ]);
      })
    );

    it.effect.prop(
      "round-trips schema-generated caller-admitted entries through PostgreSQL exactly",
      [TranscriptContentEntry],
      ([entry]) =>
        Effect.gen(function* () {
          const continuity = yield* ConversationContinuity;
          yield* resetDefaultContinuity;
          const prepared = yield* continuity.prepareForTurn(defaultUserId);
          const syntheticId = TranscriptEntryId.make(
            entry.id === "f1d1a000-0000-4000-8000-0000000004a1"
              ? "f1d1a000-0000-4000-8000-0000000004a2"
              : "f1d1a000-0000-4000-8000-0000000004a1"
          );
          const userEntry =
            entry._tag === "UserTranscriptEntry"
              ? entry
              : makeUserEntry({
                  id: syntheticId,
                  turnId: entry.turnId,
                  text: TranscriptText.make("generated entry round-trip"),
                  occurredAt: entry.occurredAt,
                });
          const handle = yield* continuity.beginTurn(defaultUserId, prepared, userEntry);

          if (
            entry._tag === "CanonicalToolCallEntry" ||
            entry._tag === "CanonicalToolResultEntry"
          ) {
            yield* continuity.appendTurn(defaultUserId, handle, [entry]);
          } else if (entry._tag === "AssistantTranscriptEntry") {
            yield* continuity.completeTurn(defaultUserId, handle, {
              entry,
              terminalAt: entry.occurredAt,
            });
          }

          const observed = yield* continuity.observe(defaultUserId);
          expect(observed.entries.find((candidate) => candidate.id === entry.id)).toEqual(entry);
        }),
      { timeout: 30_000, fastCheck: { numRuns: 40 } }
    );

    it.effect("isolates preparation, recovery, observation, and terminal authority by User", () =>
      Effect.gen(function* () {
        const continuity = yield* ConversationContinuity;
        yield* resetDefaultContinuity;
        yield* resetIsolatedUser;
        const firstTurnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000441");
        const firstEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000442"),
          turnId: firstTurnId,
          text: TranscriptText.make("first user"),
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:00:00Z"),
        });
        const firstPrepared = yield* continuity.prepareForTurn(defaultUserId);
        const foreignPreparation = yield* continuity
          .beginTurn(isolatedUserId, firstPrepared, firstEntry)
          .pipe(Effect.exit);
        assertFailure(foreignPreparation, new ContinuityAuthorityRejected({ reason: "Foreign" }));
        const firstHandle = yield* continuity.beginTurn(defaultUserId, firstPrepared, firstEntry);
        const secondBefore = yield* continuity.prepareForTurn(isolatedUserId);
        expect(secondBefore.entries).toEqual([]);
        expect(secondBefore.turns).toEqual([]);
        const foreignHandle = yield* continuity
          .failTurn(isolatedUserId, firstHandle, {
            reason: "DeliveryFailed",
            terminalAt: DateTime.makeUnsafe("2026-08-11T16:00:01Z"),
          })
          .pipe(Effect.exit);
        assertFailure(foreignHandle, new TurnAuthorityRejected({ reason: "Foreign" }));

        const secondTurnId = TranscriptTurnId.make("f1d1a000-0000-4000-8000-000000000451");
        const secondEntry = makeUserEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000452"),
          turnId: secondTurnId,
          text: TranscriptText.make("second user"),
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:00:00Z"),
        });
        const secondHandle = yield* continuity.beginTurn(isolatedUserId, secondBefore, secondEntry);
        const secondAssistant = makeAssistantEntry({
          id: TranscriptEntryId.make("f1d1a000-0000-4000-8000-000000000453"),
          turnId: secondTurnId,
          text: TranscriptText.make("second complete"),
          occurredAt: DateTime.makeUnsafe("2026-08-11T16:00:01Z"),
        });
        const recoveredFirst = yield* continuity.prepareForTurn(defaultUserId);
        const recoveredHandle = yield* continuity
          .failTurn(defaultUserId, firstHandle, {
            reason: "DeliveryFailed",
            terminalAt: DateTime.makeUnsafe("2026-08-11T16:00:02Z"),
          })
          .pipe(Effect.exit);
        assertFailure(recoveredHandle, new TurnAuthorityRejected({ reason: "Consumed" }));
        const pendingSecond = yield* continuity.observe(isolatedUserId);
        expect(recoveredFirst.turns[0]).toMatchObject({ _tag: "Interrupted" });
        expect(pendingSecond.turns).toEqual([
          {
            _tag: "Pending",
            id: secondTurnId,
            startedAt: DateTime.makeUnsafe("2026-08-11T16:00:00Z"),
          },
        ]);
        expect(pendingSecond.entries).toEqual([secondEntry]);

        yield* continuity.completeTurn(isolatedUserId, secondHandle, {
          entry: secondAssistant,
          terminalAt: DateTime.makeUnsafe("2026-08-11T16:00:02Z"),
        });
        const completedSecond = yield* continuity.observe(isolatedUserId);
        expect(completedSecond.turns[0]).toMatchObject({ _tag: "Completed" });
        expect(completedSecond.entries).toEqual([secondEntry, secondAssistant]);
      })
    );
  }
);
