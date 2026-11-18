import { recordNativeEvidence } from "./internal/native-evidence";
import { nativeScopeRequest } from "./internal/native-scope";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { preserveStoreAlarm, withStoreCapacity } from "../runtime/sqlite/operations";
import { admissionLifetimeMs, validContinuation } from "./internal/control-admission";
import type { ErasureRegistry, ErasureRegistryNamespace } from "./contract";
import { initializeRegistryStorage } from "./internal/registry-initialization";
import { sweepControlObjects } from "./internal/control-objects";
import { requireInventory } from "./internal/inventory";
import { purgeCompletedCases } from "./internal/control-retention";
import { expectedGeneration } from "./internal/generation";
import { restoreCase } from "./internal/restore-case";
import { submitCustodyEvidence } from "./internal/provider-evidence";
import { receipt, receiptNext } from "./internal/receipt";
import { recoveryWindowMs } from "./internal/retention-policy";
import { Clock, Effect, Option, Schema } from "effect";
import {
  ErasureBrowserAdmission,
  ErasureContinuation,
  type ErasureExecution,
  type ErasureOwner,
  type ErasureRecoveryConfiguration,
  type ErasureRegistryInitialization,
} from "./contract";
import { progress } from "./internal/progress";
import { ErasureUnavailable } from "../erasure-store/contract";
import type { ErasureStore } from "../erasure-store/contract";
import { admitDeletion } from "./internal/admission";
import {
  ErasureClass,
  ErasureCustodian,
  ErasureOperatorReceipt,
  ErasureReceipt,
} from "../../src/core/erasure/contract";

/** Composition inside the serialized User coordinator. Binding supplies no authority:
 * each call decodes its own admission and retains the original credentials and deadline.
 * No receipt, credential or lifecycle observation is retained across invocations. */
export const makeErasureOwner = (
  configuration: ErasureExecution & Readonly<{ userId: string }>
): ErasureOwner => ({
  admit: (candidate: unknown, signal: AbortSignal): Effect.Effect<Response> =>
    executeErasureAdmission({ ...configuration, candidate, signal }),
  continue: (candidate: unknown): Effect.Effect<Response> =>
    executeErasureContinuation({ ...configuration, candidate }),
  receipt: (candidate: unknown): Effect.Effect<Response> =>
    executeErasureControl({ ...configuration, candidate, operation: "Receipt" }),
  custody: (candidate: unknown): Effect.Effect<Response> =>
    executeErasureControl({ ...configuration, candidate, operation: "CustodyEvidence" }),
});

const conflictStatus = 409;
const acceptedStatus = 202;
const unavailableStatus = 503;
/** Accepts only private Core admissions, rechecked under the named User's existing coordinator. */
const executeErasureAdmission = (
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
    const admission = Schema.decodeUnknownOption(ErasureBrowserAdmission, {
      onExcessProperty: "error",
    })(input.candidate);
    if (
      Option.isNone(admission) ||
      admission.value.userId !== input.userId ||
      input.signal.aborted
    ) {
      return new Response(null, { status: conflictStatus });
    }
    const current = yield* Clock.currentTimeMillis;
    if (
      admission.value.deadlineMs <= current ||
      admission.value.deadlineMs > current + admissionLifetimeMs
    ) {
      return new Response(null, { status: conflictStatus });
    }
    const accepted = yield* admitDeletion({ ...input, admission: admission.value });
    return Option.isSome(accepted)
      ? Response.json(accepted.value, {
          status: acceptedStatus,
          headers: { "cache-control": "no-store" },
        })
      : new Response(null, { status: conflictStatus });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

/** A continuation is bound to the reviewed User and inventory; unresolved independent stores refuse progression. */
const executeErasureContinuation = (
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
      !validContinuation({ admission: admission.value, current, userId: input.userId })
    ) {
      return new Response(null, { status: conflictStatus });
    }
    const scope = { reference: admission.value.reference, userId: input.userId };
    yield* continueDisposition({ ...input, scope, deadlineMs: admission.value.deadlineMs });
    return new Response(null, { status: acceptedStatus });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus })));

const executeErasureControl = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    candidate: unknown;
    operation: "Receipt" | "CustodyEvidence";
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.operation === "CustodyEvidence") {
      const result = yield* submitCustodyEvidence(input);
      return new Response(null, {
        status: result === "Recorded" ? acceptedStatus : conflictStatus,
        headers: { "cache-control": "no-store" },
      });
    }
    const decoded = Schema.decodeUnknownOption(ErasureContinuation, {
      onExcessProperty: "error",
    })(input.candidate);
    const current = yield* Clock.currentTimeMillis;
    if (
      Option.isNone(decoded) ||
      !validContinuation({ admission: decoded.value, current, userId: input.userId })
    ) {
      return new Response(null, {
        status: conflictStatus,
        headers: { "cache-control": "no-store" },
      });
    }
    yield* requireInventory({
      db: input.db,
      scope: { reference: decoded.value.reference, userId: input.userId },
      stores: input.stores,
    });
    const result = yield* receipt({
      db: input.db,
      scope: { reference: decoded.value.reference, userId: input.userId },
      stores: input.stores,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.orElseSucceed(
      () =>
        new Response(null, { status: unavailableStatus, headers: { "cache-control": "no-store" } })
    )
  );

const maximumResumedCases = 4;
export const resumeErasureCases = (
  input: Readonly<{
    db: D1Database;
    coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
    bucket: Option.Option<ErasureRegistry>;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* purgeCompletedCases({ db: input.db, bucket: input.bucket });
    const pending = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare("SELECT count(*) AS pending FROM erasure_requests WHERE state<>'Complete'")
          .first<number>("pending"),
      catch: () => new ErasureUnavailable(),
    });
    if (pending === 0) return;
    const generation = yield* expectedGeneration({ db: input.db, bucket: input.bucket });
    const current = yield* Clock.currentTimeMillis;
    const rows = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT id AS reference,user_id AS userId
    FROM erasure_requests WHERE state<>'Complete' AND next_continuation_at_ms<=?
    AND (EXISTS(SELECT 1 FROM erasure_control WHERE kind='published' AND generation=?) OR EXISTS(SELECT 1 FROM erasure_control r
      JOIN erasure_restore_members m ON m.generation=r.generation WHERE r.kind='restore' AND r.scanned=1 AND r.generation=?
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
        operatorRef: "erasure-maintenance",
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
});

export const executeErasureRestore = (
  input: Readonly<{
    db: D1Database;
    recovery: ErasureRecoveryConfiguration;
    stores: ReadonlyArray<ErasureStore>;
    userId: string;
    candidate: unknown;
    signal: AbortSignal;
  }>
): Effect.Effect<Response> =>
  restoreCase({ ...input, configuration: input.recovery }).pipe(
    Effect.as(
      new Response(null, { status: acceptedStatus, headers: { "cache-control": "no-store" } })
    ),
    Effect.orElseSucceed(() => new Response(null, { status: unavailableStatus }))
  );

const continueDisposition = (
  input: ErasureExecution &
    Readonly<{ scope: Readonly<{ reference: string; userId: string }>; deadlineMs: number }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const scope = input.scope;
    if ((yield* Clock.currentTimeMillis) >= input.deadlineMs) return;
    const raw = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare("SELECT state FROM erasure_requests WHERE id=? AND user_id=?")
          .bind(scope.reference, scope.userId)
          .first(),
      catch: () => new ErasureUnavailable(),
    });
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ state: ErasureReceipt.fields.state })
    )(raw);
    yield* progress({ ...input, scope, phase: row.state });
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const sweepErasureControlObjects = (
  input: Parameters<typeof sweepControlObjects>[0]
): ReturnType<typeof sweepControlObjects> => sweepControlObjects(input);

/** Only local deployment startup may use this preparation. Ordinary data access never initializes a missing registry; existing checkpoints are preserved. */
export const prepareLocalErasureRegistry = <Requirements>(
  input: ErasureRegistryInitialization<Requirements>
): Effect.Effect<void, ErasureUnavailable, Requirements> =>
  initializeRegistryStorage({ ...input, mode: "LocalStartup" });

// Directory and Pricing retain User-attributed identity, credential, and registration records
// until their separate cleanup acknowledgements. Report only classes settled by User purge.
const localClasses = [
  "transactions",
  "memory",
  "consent",
] as const satisfies ReadonlyArray<ErasureClass>;

const viewCase = Effect.fn(function* (request: Request, storage: DurableObjectStorage) {
  const continuation = Schema.decodeUnknownOption(ErasureContinuation, {
    onExcessProperty: "error",
  })(yield* Effect.tryPromise(() => request.json()));
  const sql = yield* SqliteClient;
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (
        Option.isNone(continuation) ||
        !validContinuation({
          admission: continuation.value,
          current: now,
          userId: continuation.value.userId,
        })
      ) {
        return new Response(null, { status: 409 });
      }
      const { reference, userId } = continuation.value;
      const [record] =
        yield* sql`SELECT state,last_erased_at_ms,connection_blocked,directory_clean,pricing_clean,identity_released FROM erasure_cases WHERE reference=${reference} AND user_id=${userId}`;
      if (record === undefined) return new Response(null, { status: 409 });
      const phase = yield* Schema.decodeUnknownEffect(ErasureReceipt.fields.state)(record.state);
      const continuing = request.url === "https://coordinator.internal/erasure-continue";
      yield* sql`INSERT INTO erasure_case_operations VALUES(${reference},${continuing ? "Continue" : "Receipt"},${continuation.value.authority.operatorRef},${now},${continuing ? "pending" : "observed"})`;
      if (continuing) {
        yield* sql`UPDATE erasure_cases SET next_check_ms=${now} WHERE reference=${reference} AND user_id=${userId}`;
        yield* preserveStoreAlarm(storage, now);
        return new Response(null, { status: 202 });
      }
      return yield* caseReceipt(reference, phase, record);
    })
  );
});

const completedClasses = (
  record: Readonly<Record<string, unknown>>
): ReadonlyArray<ErasureClass> => {
  if (record.last_erased_at_ms === null) return [];
  if (record.directory_clean !== 1) return localClasses;
  return ErasureClass.literals.filter((entry) => {
    if (entry === "identity" || entry === "credentials") return record.identity_released === 1;
    if (entry === "billing") return record.pricing_clean === 1;
    return true;
  });
};
const caseReceipt = Effect.fn(function* (
  reference: string,
  phase: typeof ErasureReceipt.Type.state,
  record: Readonly<Record<string, unknown>>
) {
  const sql = yield* SqliteClient;
  const owners = ErasureCustodian.literals;
  const custody =
    yield* sql`SELECT c.custodian,coalesce(e.status,'Pending') AS status,e.reason FROM erasure_case_custodians c LEFT JOIN erasure_case_evidence e ON e.id=c.event_id AND e.reference=c.reference AND e.custodian=c.custodian AND e.status=c.status WHERE c.reference=${reference}`;
  const dispositions = yield* Schema.decodeUnknownEffect(ErasureOperatorReceipt.fields.custodians)(
    owners.map((custodian) => {
      const row = custody.find((entry) => entry.custodian === custodian);
      return row?.status === "Unresolved" ? row : { custodian, status: row?.status ?? "Pending" };
    })
  );
  const receipt = yield* Schema.encodeEffect(ErasureOperatorReceipt)({
    reference,
    state: phase,
    next: receiptNext({
      state: phase,
      connectionBlocked: yield* Schema.decodeUnknownEffect(Schema.Literals([0, 1]))(
        record.connection_blocked
      ),
    }),
    completed: completedClasses(record),
    custodians: dispositions,
    recoveryUntilMs:
      record.last_erased_at_ms === null
        ? null
        : (yield* Schema.decodeUnknownEffect(Schema.Int)(record.last_erased_at_ms)) +
          recoveryWindowMs,
  });
  return Response.json(receipt, { headers: { "cache-control": "no-store" } });
});

/** The named Erasure object receives an Access-authenticated, short-lived continuation from ingress. */
export const caseOperatorRequest = Effect.fn(function* (
  request: Request,
  storage: DurableObjectStorage,
  directory: ErasureRegistryNamespace
) {
  switch (request.url) {
    case "https://coordinator.internal/erasure-custody-evidence":
      return yield* recordNativeEvidence(request, storage);
    case "https://coordinator.internal/erasure-custody-scope":
    case "https://erasure.invalid/case/confirm-scope":
      return yield* nativeScopeRequest(request, directory);
    case "https://coordinator.internal/erasure-receipt":
    case "https://coordinator.internal/erasure-continue":
      return yield* viewCase(request, storage);
    default:
      return new Response(null, { status: 404 });
  }
});
