import { recordNativeEvidence } from "./internal/native-evidence";
import { nativeScopeRequest } from "./internal/native-scope";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { preserveStoreAlarm, withStoreCapacity } from "../runtime/sqlite/operations";
import { validContinuation } from "./internal/control-admission";
import type { ErasureRegistryNamespace } from "./contract";
import { initializeRegistryStorage } from "./internal/registry-initialization";
import { receiptNext } from "./internal/receipt";
import { recoveryWindowMs } from "./internal/retention-policy";
import { Clock, Effect, Option, Schema } from "effect";
import { ErasureContinuation, type ErasureRegistryInitialization } from "./contract";
import { type ErasureUnavailable } from "../erasure-store/contract";
import {
  ErasureClass,
  ErasureCustodian,
  ErasureOperatorReceipt,
  ErasureReceipt,
} from "../../src/core/erasure/contract";

export const prepareLocalErasureRegistry = <Requirements>(
  input: ErasureRegistryInitialization<Requirements>
): Effect.Effect<void, ErasureUnavailable, Requirements> =>
  initializeRegistryStorage({ ...input, mode: "LocalStartup" });

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

      if (request.url === "https://coordinator.internal/erasure-continue") {
        yield* sql`UPDATE erasure_cases SET next_check_ms=${now} WHERE reference=${reference} AND user_id=${userId}`;
        yield* preserveStoreAlarm(storage, now);

        return new Response(null, { status: 202 });
      }

      return yield* caseReceipt(reference, phase, record);
    })
  );
});

const ReceiptCase = Schema.Struct({
  last_erased_at_ms: Schema.Unknown,
  connection_blocked: Schema.Unknown,
  directory_clean: Schema.Unknown,
  pricing_clean: Schema.Unknown,
  identity_released: Schema.Unknown,
});

const completedClasses = (record: typeof ReceiptCase.Type): ReadonlyArray<ErasureClass> => {
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
  raw: unknown
) {
  const sql = yield* SqliteClient;
  const record = yield* Schema.decodeUnknownEffect(ReceiptCase)(raw);
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
