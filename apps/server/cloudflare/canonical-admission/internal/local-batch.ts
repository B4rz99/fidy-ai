import { recurringDiscoveryIntervalMs } from "../../recurring/contract";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { CanonicalRetryKey } from "../../../src/core/quotas/contract";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type CatalogOperation,
  getBoundOperationCatalog,
} from "../../../src/shell/canonical-catalog/contract";
import { grantsRequiredTier } from "../../../src/shell/canonical-operations/operations";
import { decideOperationAccess } from "../../../src/shell/canonical-policy/operations";
import {
  AtomicBatchCallId,
  atomicBatchChildOperations,
  maximumAtomicBatchCalls,
} from "../../../src/shell/operations/contract";
import { ErrorCode } from "../../../src/shell/public-http/contract";
import {
  maximumTransactionGroupInputBytes,
  maximumTransactionInputBytes,
} from "../../canonical-work/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { preserveStoreAlarm, withStoreAdmission } from "../../runtime/sqlite/operations";
import {
  type CanonicalAdmissionUnavailable,
  type LocalMutationPlan,
  type LocalMutationPreparation,
  type LocalMutationResult,
} from "../contract";
import {
  type Call,
  type Invocation,
  admitLocalRequest,
  audit,
  charge,
  complete,
  financialGrowth,
  localProof,
  localRetryKey,
  localStanding,
  reject,
  replay,
  replayableOperations,
  sweepLocalReceipts,
  withdrawn,
} from "./local-mutation";
import { cryptoHash, normalized } from "./request-input";
import {
  attachStanding,
  canonicalAdmissionUnavailable,
  invalid,
  noAuthority,
  rateLimited,
  scopeMissing,
} from "./responses";

const firstFailureStatus = 400;
const envelope = Schema.Struct({
  calls: Schema.NonEmptyArray(Schema.Json).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
});
const childEnvelope = Schema.Struct({
  callId: AtomicBatchCallId,
  operation: Schema.String,
  input: Schema.Json,
});
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes:
    maximumTransactionGroupInputBytes + maximumAtomicBatchCalls * maximumTransactionInputBytes,
  deadlineMilliseconds: 5000,
});
type Prepare = (
  input: unknown,
  context: { user: UserId; current: number; storage: DurableObjectStorage }
) => Effect.Effect<LocalMutationPreparation, CanonicalAdmissionUnavailable, SqliteClient>;
type Unit = {
  request: Request;
  owns: (id: string) => boolean;
  operation: CatalogOperation;
  storage: DurableObjectStorage;
};
type Child = {
  callId: string;
  operation: CatalogOperation;
  input: Schema.Json;
  index: number;
  prepare: Prepare;
};
type Refusal = { operation: CatalogOperation; index: number; code: ErrorCode; message: string };
class ChildRefused extends Data.TaggedError("ChildRefused")<Refusal> {}
const failed = ({ index, operation, code, message }: Refusal): LocalMutationResult => ({
  status: 400,
  outcome: "validation_failed",
  body: {
    error: { code, message, failedCallIndex: index, operation: operation.id, fields: [] },
    next: [],
  },
});
const childFailure = (child: Child, outcome: LocalMutationResult): ChildRefused => {
  const decoded = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.Struct({ code: ErrorCode, message: Schema.String }) })
  )(outcome.body);
  return new ChildRefused({ ...child, ...decoded.error });
};
type Selection = { children: ReadonlyArray<Child> } | { refusal: Refusal } | { invalid: true };
const invalidTarget = (operation: CatalogOperation, input: Schema.Json): boolean => {
  if (
    ![
      "transactions.updateTransaction",
      "transactions.deleteTransaction",
      "categories.updateKeywordRule",
      "categories.deleteKeywordRule",
    ].includes(operation.id)
  ) {
    return false;
  }
  const params = Schema.decodeUnknownOption(
    Schema.Struct({ params: Schema.Struct({ id: Schema.String }) })
  )(input);
  return (
    Option.isSome(params) &&
    !Schema.is(Schema.String.check(Schema.isUUID()))(params.value.params.id)
  );
};
const invalidChildInput = (operation: CatalogOperation, input: Schema.Json): boolean => {
  const limit =
    operation.id === "transactions.updateTransactions"
      ? maximumTransactionGroupInputBytes
      : maximumTransactionInputBytes;
  return (
    new TextEncoder().encode(JSON.stringify(input)).length > limit ||
    Option.isNone(Schema.decodeOption(operation.input, { onExcessProperty: "error" })(input))
  );
};
const invalidChildFailure = (
  operation: CatalogOperation,
  input: Schema.Json
): Pick<Refusal, "code" | "message"> =>
  invalidTarget(operation, input)
    ? { code: "not_found", message: "The requested record is unavailable." }
    : { code: "validation_failed", message: "Invalid canonical child input." };
const selectChildren = (
  calls: ReadonlyArray<Schema.Json>,
  owners: ReadonlyMap<string, Prepare>
): Selection => {
  const catalog = getBoundOperationCatalog();
  const eligible = new Set(atomicBatchChildOperations(catalog).map((op) => op.id));
  const ids = new Set<string>();
  const children: Child[] = [];
  for (const [index, raw] of calls.entries()) {
    const named = Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(raw);
    const operation = Option.getOrUndefined(
      Option.flatMap(named, ({ operation: id }) => Option.fromUndefinedOr(catalog.byId.get(id)))
    );
    if (operation === undefined) return { invalid: true } as const;
    const child = Schema.decodeUnknownOption(childEnvelope, { onExcessProperty: "error" })(raw);
    const refusal = (code: ErrorCode, message: string): Selection =>
      ({ refusal: { index, operation, code, message } }) as const;
    if (!eligible.has(operation.id) || Option.isNone(child)) {
      return refusal(
        "validation_failed",
        "Each child must identify one eligible mutation and its inputs."
      );
    }
    const { input, callId } = child.value;
    if (ids.has(callId)) return refusal("validation_failed", "Each child needs its own callId.");
    ids.add(callId);
    if (invalidChildInput(operation, input)) {
      const failure = invalidChildFailure(operation, input);
      return refusal(failure.code, failure.message);
    }
    const prepare = owners.get(operation.id);
    if (prepare === undefined) {
      return refusal("unavailable", "This mutation has no native batch owner.");
    }
    children.push({ index, callId, input, operation, prepare });
  }
  return { children } as const;
};

const childAccess = Effect.fn(function* (call: Call, children: ReadonlyArray<Child>) {
  const { subject, current, status } = call;
  const sql = yield* SqliteClient;
  const caller =
    "patId" in subject
      ? { _tag: "PAT" as const, capabilities: subject.scopes }
      : {
          _tag: "WebSession" as const,
          fresh:
            (yield* sql`SELECT 1 FROM web_sessions WHERE id=${subject.sessionId} AND user_id=${subject.userId} AND fresh_until_ms>${current}`)
              .length === 1,
        };
  for (const child of children) {
    if (decideOperationAccess(child.operation.policy.access, caller)._tag !== "Allowed") {
      yield* audit({ ...call, operation: child.operation }, "validation_failed");
      return Option.some(yield* reject(call, scopeMissing()));
    }
    if (
      !grantsRequiredTier({
        requiredTier: child.operation.policy.requiredTier,
        callerTier: status.accessTier,
      })
    ) {
      const failure = failed({
        ...child,
        code: "paywall_required",
        message: "Your Subscription tier does not grant this operation.",
      });
      yield* audit({ ...call, operation: child.operation }, "validation_failed");
      return Option.some(yield* reject(call, Response.json(failure.body, { status: 400 })));
    }
  }
  return Option.none<Response>();
});

const reserveTargets = (
  plan: LocalMutationPlan,
  targets: Set<string>,
  premises: Set<string>
): boolean => {
  if (
    plan.targets.some((target) => targets.has(target) || premises.has(target)) ||
    plan.premises.some((premise) => targets.has(premise))
  ) {
    return false;
  }
  for (const target of plan.targets) targets.add(target);
  for (const premise of plan.premises) premises.add(premise);
  return true;
};

const applyChildren = Effect.fn(function* (call: Call, children: ReadonlyArray<Child>) {
  const sql = yield* SqliteClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const plans: Array<{ child: Child; plan: LocalMutationPlan }> = [];
        const targets = new Set<string>();
        const premises = new Set<string>();
        for (const child of children) {
          const plan = yield* child.prepare(child.input, {
            user: call.subject.userId,
            current: call.current,
            storage: call.storage,
          });
          if (!("commit" in plan)) return yield* childFailure(child, plan);
          if (!reserveTargets(plan, targets, premises)) {
            return yield* new ChildRefused({
              ...child,
              code: "validation_failed",
              message: "Two children address the same retained target.",
            });
          }
          plans.push({ child, plan });
        }
        const results = [];
        for (const { child, plan } of plans) {
          const result = yield* plan.commit;
          if (result.status >= firstFailureStatus) return yield* childFailure(child, result);
          yield* Schema.decodeEffect(child.operation.success, { onExcessProperty: "error" })(
            result.body
          );
          yield* audit({ ...call, operation: child.operation }, result.outcome);
          results.push({
            callId: child.callId,
            operation: child.operation.id,
            output: result.body,
          });
        }
        if (children.some((child) => child.operation.id.startsWith("transactions."))) {
          yield* preserveStoreAlarm(call.storage, call.current + recurringDiscoveryIntervalMs);
        }
        return { status: 200, outcome: "success" as const, body: { data: { results }, next: [] } };
      })
    )
    .pipe(
      Effect.catchTag("ChildRefused", (failure) =>
        audit(
          { ...call, operation: failure.operation },
          failure.code === "not_found" ? "not_found" : "validation_failed"
        ).pipe(Effect.as(failed(failure)))
      )
    );
});

const commitAuthorizedBatch = Effect.fn(function* (
  call: Call,
  {
    children,
    invocation,
    admitGrowth,
  }: {
    children: ReadonlyArray<Child>;
    invocation: Invocation;
    admitGrowth: Effect.Effect<void, StoreCapacityUnavailable>;
  }
) {
  const denied = yield* childAccess(call, children);
  if (Option.isSome(denied)) return denied.value;
  yield* sweepLocalReceipts(call.current);
  const prior = yield* replay(call, invocation);
  if (Option.isSome(prior)) return prior.value;
  const refused = yield* charge(call);
  if (Option.isSome(refused)) return refused.value;
  if (children.some((child) => financialGrowth.has(child.operation.id))) yield* admitGrowth;
  const outcome = yield* applyChildren(call, children);
  return yield* complete(call, invocation, {
    ...outcome,
    retain: children.every((child) => replayableOperations.has(child.operation.id)),
  });
});

/** Fresh credential, each child's policy, one commercial call and all owner effects share this native transaction. */
export const runLocalBatch = Effect.fn(
  function* (unit: Unit, owners: ReadonlyMap<string, Prepare>) {
    const resolve = yield* localProof(unit.request, unit.owns);
    const input = yield* boundedJsonBody({
      request: unit.request,
      policy: bodyPolicy,
      schema: envelope,
    });
    const rawKey = localRetryKey(unit.request);
    const key = Schema.decodeUnknownOption(CanonicalRetryKey)(rawKey);
    const validInput = Option.filter(input, () => rawKey === null || Option.isSome(key));
    const digest = yield* Effect.forEach(Option.toArray(key), cryptoHash).pipe(
      Effect.map((values) => Option.fromUndefinedOr(values[0]))
    );
    const inputHash = Option.isSome(input)
      ? yield* cryptoHash(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(normalized(input.value))
        )
      : "";
    return yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const subject = yield* resolve(current);
        if (subject === "unauthenticated") return noAuthority();
        if (subject === "consent_revoked") return withdrawn();
        const call = {
          ...unit,
          current,
          subject,
          status: yield* localStanding(subject.userId, current),
        };
        if ((yield* admitLocalRequest({ user: subject.userId, current })).length !== 1) {
          return attachStanding({ ...call, response: rateLimited() });
        }
        if (Option.isNone(validInput)) {
          return yield* reject(call, invalid("Invalid batch envelope or retry key."));
        }
        const selected = selectChildren(validInput.value.calls, owners);
        if ("invalid" in selected) {
          return yield* reject(call, invalid("Unknown canonical child operation."));
        }
        if ("refusal" in selected) {
          const attempted = { ...call, operation: selected.refusal.operation };
          yield* audit(
            attempted,
            selected.refusal.code === "not_found" ? "not_found" : "validation_failed"
          );
          return attachStanding({
            ...call,
            response: Response.json(failed(selected.refusal).body, { status: 400 }),
          });
        }
        const { children } = selected;
        return yield* commitAuthorizedBatch(call, {
          children,
          invocation: { inputHash, digest },
          admitGrowth,
        });
      })
    );
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);
