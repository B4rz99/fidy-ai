import { initializeRegistryStorage } from "./internal/registry-initialization";
import { reviewControlRetention } from "./internal/retention-review";
import { sweepControlObjects } from "./internal/control-objects";
import { requireInventory } from "./internal/inventory";
import { purgeCompletedCases } from "./internal/control-retention";
import { expectedGeneration } from "./internal/generation";
import { restoreCase } from "./internal/restore-case";
import { recordCustodyEvidence } from "./internal/provider-evidence";
import { receipt } from "./internal/receipt";
import { Clock, Effect, Option, Schema } from "effect";
import {
  ErasureContinuation,
  ErasureCustodyAdmission,
  type ErasureExecution,
  type ErasureRecoveryConfiguration,
  type ErasureRegistryInitialization,
  ErasureRetentionAdmission,
  ErasureReviewAdmission,
} from "./contract";
import { progress } from "./internal/progress";
import { ErasureUnavailable } from "../erasure-store/contract";
import type { ErasureStore } from "../erasure-store/contract";
import { review } from "./internal/review";

const conflictStatus = 409;
const admissionLifetimeMs = 5000;
const acceptedStatus = 202;
const unavailableStatus = 503;
/** Accepts only private Core admissions, rechecked under the named User's existing coordinator. */
export const executeErasureReview = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    candidate: unknown;
    signal: AbortSignal;
    stores: ReadonlyArray<ErasureStore>;
    recovery: ErasureRecoveryConfiguration;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const admission = Schema.decodeUnknownOption(ErasureReviewAdmission, {
      onExcessProperty: "error",
    })(input.candidate);
    if (
      Option.isNone(admission) ||
      admission.value.userId !== input.userId ||
      input.signal.aborted
    ) {
      return new Response(null, { status: conflictStatus });
    }
    const approved = yield* review({ ...input, admission: admission.value });
    return new Response(null, {
      status: approved ? acceptedStatus : conflictStatus,
      headers: { "cache-control": "no-store" },
    });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

/** A continuation is bound to the reviewed User and inventory; unresolved independent stores refuse progression. */
export const executeErasureContinuation = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    candidate: unknown;
  }> &
    ErasureExecution
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const admission = Schema.decodeUnknownOption(ErasureContinuation, {
      onExcessProperty: "error",
    })(input.candidate);
    const current = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(admission) ||
      admission.value.userId !== input.userId ||
      admission.value.deadlineMs <= current ||
      admission.value.authority.expiresAtMs <= current ||
      admission.value.deadlineMs > current + admissionLifetimeMs
    ) {
      return new Response(null, { status: conflictStatus });
    }
    const scope = { reference: admission.value.reference, userId: input.userId };
    yield* continueDisposition({ ...input, scope, deadlineMs: admission.value.deadlineMs });
    return new Response(null, { status: acceptedStatus });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

export const executeErasureControl = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    candidate: unknown;
    operation: "Receipt" | "CustodyEvidence";
    bucket: Option.Option<R2Bucket>;
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const decoded =
      input.operation === "CustodyEvidence"
        ? Schema.decodeUnknownOption(ErasureCustodyAdmission, { onExcessProperty: "error" })(
            input.candidate
          )
        : Schema.decodeUnknownOption(ErasureContinuation, { onExcessProperty: "error" })(
            input.candidate
          );
    const current = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(decoded) ||
      !validContinuation({ admission: decoded.value, current, userId: input.userId })
    ) {
      return new Response(null, { status: conflictStatus });
    }
    yield* requireInventory({
      db: input.db,
      scope: { reference: decoded.value.reference, userId: input.userId },
      stores: input.stores,
    });
    if (input.operation === "CustodyEvidence") {
      const admission = yield* Schema.decodeUnknownEffect(ErasureCustodyAdmission)(decoded.value);
      const recorded = yield* recordCustodyEvidence({ db: input.db, admission });
      return new Response(null, {
        status: recorded ? acceptedStatus : conflictStatus,
        headers: { "cache-control": "no-store" },
      });
    }
    const result = yield* receipt({
      db: input.db,
      bucket: input.bucket,
      scope: { reference: decoded.value.reference, userId: input.userId },
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

const validContinuation = (
  input: Readonly<{ admission: ErasureContinuation; current: number; userId: string }>
): boolean =>
  input.admission.userId === input.userId &&
  input.admission.deadlineMs > input.current &&
  input.admission.deadlineMs <= input.current + admissionLifetimeMs &&
  input.admission.authority.expiresAtMs > input.current;

const maximumResumedCases = 4;
export const resumeErasureCases = (
  input: Readonly<{
    db: D1Database;
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
    bucket: Option.Option<R2Bucket>;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* purgeCompletedCases({ db: input.db, bucket: input.bucket });
    const pending = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(
            "SELECT count(*) AS pending FROM erasure_requests WHERE decision_json IS NOT NULL AND state<>'Complete'"
          )
          .first<number>("pending"),
      catch: () => new ErasureUnavailable(),
    });
    if (pending === 0) return;
    const generation = yield* expectedGeneration({ db: input.db, bucket: input.bucket });
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT id AS reference,user_id AS userId,operator_ref AS operatorRef
    FROM erasure_requests WHERE state NOT IN('AwaitingReview','Complete') AND decision_json IS NOT NULL AND next_continuation_at_ms<=?
    AND (EXISTS(SELECT 1 FROM erasure_generation WHERE id=1 AND generation=?) OR EXISTS(SELECT 1 FROM erasure_restore_sessions r
      JOIN erasure_restore_members m ON m.generation=r.generation WHERE r.id=1 AND r.scanned=1 AND r.generation=?
      AND m.request_id=erasure_requests.id AND m.user_id=erasure_requests.user_id AND erasure_requests.restore_generation=r.generation))
    ORDER BY last_continued_at_ms,requested_at_ms LIMIT ?`)
          .bind(current, generation.generation, generation.generation, maximumResumedCases)
          .all(),
      catch: () => new ErasureUnavailable(),
    });
    const cases = yield* Schema.decodeUnknownEffect(Schema.Array(ResumableCase))(rows.results);
    for (const entry of cases) {
      yield* resumeCase({ ...input, entry, current });
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

const resumeCase = (
  input: Readonly<{
    db: D1Database;
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
    entry: typeof ResumableCase.Type;
    current: number;
  }>
): Effect.Effect<void, ErasureUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { entry, current } = input;
    const now = yield* Clock.currentTimeMillis;
    const admission = {
      reference: entry.reference,
      userId: entry.userId,
      deadlineMs: now + admissionLifetimeMs,
      authority: {
        permission: "titular.erase",
        operatorRef: entry.operatorRef,
        expiresAtMs: now + admissionLifetimeMs,
      },
    };
    const checked = yield* Schema.decodeUnknownEffect(ErasureContinuation)(admission);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(ErasureContinuation))(checked);
    yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare("UPDATE erasure_requests SET last_continued_at_ms=? WHERE id=? AND user_id=?")
          .bind(current, entry.reference, entry.userId)
          .run(),
      catch: () => new ErasureUnavailable(),
    });
    const response = yield* Effect.tryPromise({
      try: () =>
        input.coordinator
          .getByName(entry.userId)
          .fetch(
            new Request("https://coordinator.internal/erasure-continue", { method: "POST", body })
          ),
      catch: () => new ErasureUnavailable(),
    });
    if (response.status !== acceptedStatus) return yield* new ErasureUnavailable();
  });

const ResumableCase = Schema.Struct({
  reference: Schema.String,
  userId: Schema.String,
  operatorRef: Schema.String,
});

export const executeErasureRestore = (
  input: Readonly<{
    db: D1Database;
    recovery: ErasureRecoveryConfiguration;
    stores: ReadonlyArray<ErasureStore>;
    userId: string;
    candidate: unknown;
  }>
): Effect.Effect<Response> =>
  restoreCase({ ...input, configuration: input.recovery }).pipe(
    Effect.as(
      new Response(null, { status: acceptedStatus, headers: { "cache-control": "no-store" } })
    ),
    Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus }))
  );

const maximumContinuationSteps = 2;
const continueDisposition = (
  input: ErasureExecution &
    Readonly<{ scope: Readonly<{ reference: string; userId: string }>; deadlineMs: number }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const scope = input.scope;
    for (let count = 0; count < maximumContinuationSteps; count++) {
      if ((yield* Clock.currentTimeMillis) >= input.deadlineMs) return;
      const raw = yield* Effect.tryPromise({
        try: () =>
          input.db
            .prepare("SELECT state FROM erasure_requests WHERE id=? AND user_id=?")
            .bind(scope.reference, scope.userId)
            .first(),
        catch: () => new ErasureUnavailable(),
      });
      const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ state: Schema.String }))(raw);
      yield* progress({ ...input, scope, phase: row.state });
      if (!["Archiving", "Erasing"].includes(row.state)) return;
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const sweepErasureControlObjects = (
  input: Parameters<typeof sweepControlObjects>[0]
): ReturnType<typeof sweepControlObjects> => sweepControlObjects(input);

export const executeErasureRetentionReview = (
  input: Readonly<{
    userId: string;
    candidate: unknown;
    recovery: ErasureRecoveryConfiguration;
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const admission = Schema.decodeUnknownOption(ErasureRetentionAdmission, {
      onExcessProperty: "error",
    })(input.candidate);
    const current = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(admission) ||
      !validContinuation({ admission: admission.value, current, userId: input.userId })
    ) {
      return new Response(null, { status: conflictStatus });
    }
    yield* requireInventory({
      db: input.recovery.db,
      stores: input.stores,
      scope: { reference: admission.value.reference, userId: input.userId },
    });
    const accepted = yield* reviewControlRetention({
      configuration: input.recovery,
      admission: admission.value,
    });
    return new Response(null, { status: accepted ? acceptedStatus : conflictStatus });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

/** Only local deployment startup may use this preparation. Ordinary data access never initializes a missing registry; existing checkpoints are preserved. */
export const prepareLocalErasureRegistry = <Requirements>(
  input: ErasureRegistryInitialization<Requirements>
): Effect.Effect<void, ErasureUnavailable, Requirements> =>
  initializeRegistryStorage({ ...input, mode: "LocalStartup" });
