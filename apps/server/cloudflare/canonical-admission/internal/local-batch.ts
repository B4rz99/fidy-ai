import {
  OperationAccessCaller,
  OperationAccessDecision,
} from "../../../src/shell/canonical-policy/contract";
import { confirmLocalOAuth } from "../../oauth-confirmation/operations";
import {
  type Audit,
  type Child,
  type Prepare,
  type Refusal,
  type SelectedChild,
  childRejection,
  commitChildren,
  prepareChildren,
  refuseChild,
} from "./local-batch-plans";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Predicate, Schema } from "effect";
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
import { type ErrorCode } from "../../../src/shell/public-http/contract";
import {
  maximumTransactionGroupInputBytes,
  maximumTransactionInputBytes,
} from "../../canonical-work/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBodyWithSize } from "../../http/operations";
import { withStoreAdmission } from "../../runtime/sqlite/operations";
import {
  CanonicalAdmissionUnavailable,
  type CanonicalOutcome,
  type CanonicalRejectionOutcome,
  canonicalRejectionStatus,
} from "../contract";
import { catchRejection, rejectionResponse } from "./rejection";
import {
  type Call,
  type Invocation,
  admitLocalRequest,
  audit,
  charge,
  complete,
  localProof,
  localRetryKey,
  localStanding,
  reject,
  replay,
  replayableBatchChild,
  requiresGrowthAdmission,
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

const isResponse = Schema.is(Schema.instanceOf(Response));

const firstFailureStatus = canonicalRejectionStatus.badRequest;

const envelope = Schema.Struct({
  calls: Schema.NonEmptyArray(Schema.Json).check(Schema.isMaxLength(maximumAtomicBatchCalls)),
});

const childEnvelope = Schema.Struct({
  callId: AtomicBatchCallId,
  operation: Schema.String,
  input: Schema.Json,
});

const ordinaryBatchBytes = maximumAtomicBatchCalls * maximumTransactionInputBytes;

const isTransactionUpdate = Schema.is(
  Schema.Struct({ operation: Schema.Literal("transactions.updateTransactions") })
);

const withinEnvelopeLimit = (body: typeof envelope.Type, byteLength: number): boolean =>
  body.calls.some(isTransactionUpdate) || byteLength <= ordinaryBatchBytes;

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes:
    maximumTransactionGroupInputBytes + maximumAtomicBatchCalls * maximumTransactionInputBytes,
  deadlineMilliseconds: 5000,
});

type Unit = {
  request: Request;
  owns: (id: string) => boolean;
  operation: CatalogOperation;
  storage: DurableObjectStorage;
  reserveChildRoute: (
    id: UserId
  ) => Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient>;
};

type ReservedOwner<E, R> = { reserve: (input: Schema.Json) => Effect.Effect<Prepare, E, R> };

type Selection<Owner> =
  | { children: ReadonlyArray<SelectedChild<Owner>> }
  | { refusal: Refusal }
  | { invalid: true };

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

const exceedsChildLimit = (operation: CatalogOperation, input: Schema.Json): boolean => {
  const limit =
    operation.id === "transactions.updateTransactions"
      ? maximumTransactionGroupInputBytes
      : maximumTransactionInputBytes;

  return new TextEncoder().encode(JSON.stringify(input)).length > limit;
};

const refusalOutcome = (code: ErrorCode): CanonicalRejectionOutcome =>
  code === "not_found" ? "not_found" : "validation_failed";

const invalidChildInput = (operation: CatalogOperation, input: Schema.Json): boolean =>
  exceedsChildLimit(operation, input) ||
  Option.isNone(Schema.decodeOption(operation.input, { onExcessProperty: "error" })(input));

const invalidChildFailure = (
  operation: CatalogOperation,
  input: Schema.Json
): Pick<Refusal, "code" | "message"> => {
  if (exceedsChildLimit(operation, input)) {
    return {
      code: "validation_failed",
      message: "This child's input exceeds the size an individual call of this operation accepts.",
    };
  }

  return invalidTarget(operation, input)
    ? { code: "not_found", message: "The requested record is unavailable." }
    : { code: "validation_failed", message: "Invalid canonical child input." };
};

const eligibleChild = (
  eligible: ReadonlySet<string>,
  id: string,
  raw: Schema.Json
): Option.Option<typeof childEnvelope.Type> =>
  eligible.has(id)
    ? Schema.decodeUnknownOption(childEnvelope, { onExcessProperty: "error" })(raw)
    : Option.none();

export const selectChildren = <Owner>({
  calls,
  owners,
  allowed,
}: {
  calls: ReadonlyArray<Schema.Json>;
  owners: ReadonlyMap<string, Owner>;
  allowed: (op: CatalogOperation) => boolean;
}): Selection<Owner> => {
  const catalog = getBoundOperationCatalog();
  const eligible = new Set(atomicBatchChildOperations(catalog).map((op) => op.id));
  const ids = new Set<string>();
  const children: SelectedChild<Owner>[] = [];

  for (const [index, raw] of calls.entries()) {
    const named = Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(raw);

    const operation = Option.getOrUndefined(
      Option.flatMap(named, ({ operation: id }) => Option.fromUndefinedOr(catalog.byId.get(id)))
    );

    if (operation === undefined) return { invalid: true } as const;
    const child = eligibleChild(eligible, operation.id, raw);

    const refusal = (code: ErrorCode, message: string): Selection<Owner> =>
      ({
        refusal: {
          index,
          operation,
          code,
          message,
          outcome: refusalOutcome(code),
        },
      }) as const;

    if (Option.isNone(child)) {
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

    if (!allowed(operation)) {
      return refusal("scope_missing", "This caller cannot invoke the child operation.");
    }

    const prepare = owners.get(operation.id);

    if (prepare === undefined) {
      return refusal("unavailable", "This mutation has no native batch owner.");
    }

    children.push({ index, callId, input, operation, prepare });
  }

  return { children } as const;
};

const childCaller = Effect.fn(function* ({ subject, current }: Pick<Call, "subject" | "current">) {
  if ("oauth" in subject) return OperationAccessCaller.OAuthAgent({ capabilities: subject.scopes });

  if ("patId" in subject) return OperationAccessCaller.PAT({ capabilities: subject.scopes });
  const sql = yield* SqliteClient;

  return OperationAccessCaller.WebSession({
    fresh:
      (yield* sql`SELECT 1 FROM web_sessions WHERE id=${subject.sessionId} AND user_id=${subject.userId} AND fresh_until_ms>${current}`)
        .length === 1,
  });
});

const childAccess = Effect.fn(function* (
  call: Call,
  children: ReadonlyArray<Pick<Child, "operation" | "index">>
) {
  const { status } = call;
  const caller = yield* childCaller(call);

  const entitled = (child: Pick<Child, "operation" | "index">): boolean =>
    grantsRequiredTier({
      requiredTier: child.operation.policy.requiredTier,
      callerTier: status.accessTier,
    });

  const blocked = Option.fromUndefinedOr(
    children.find(
      (child) =>
        !OperationAccessDecision.$is("Allowed")(
          decideOperationAccess(child.operation.policy.access, caller)
        ) || !entitled(child)
    )
  );

  if (Option.isNone(blocked)) return Option.none<Response>();
  const child = blocked.value;

  const access = decideOperationAccess(child.operation.policy.access, caller);

  if (OperationAccessDecision.$is("Denied")(access)) {
    yield* audit({ ...call, operation: child.operation }, "validation_failed");

    if (access.reason === "caller_ineligible") {
      const failure = childRejection({
        index: child.index,
        operation: child.operation,
        code: "scope_missing",
        message: "This caller cannot invoke the child operation.",
        outcome: "validation_failed",
      });

      return Option.some(
        attachStanding({
          ...call,
          response: rejectionResponse(failure),
        })
      );
    }

    return Option.some(yield* reject(call, scopeMissing()));
  }

  const failure = childRejection({
    index: child.index,
    operation: child.operation,
    code: "paywall_required",
    message: "Your Subscription tier does not grant this operation.",
    outcome: "validation_failed",
  });

  yield* audit({ ...call, operation: child.operation }, "validation_failed");

  return Option.some(yield* reject(call, rejectionResponse(failure)));
});

const applyChildren = Effect.fn(function* (call: Call, children: ReadonlyArray<Child>) {
  const context = { user: call.subject.userId, current: call.current, storage: call.storage };

  const record: Audit = (child: Pick<Child, "operation" | "index">, outcome: CanonicalOutcome) =>
    audit({ ...call, operation: child.operation }, outcome).pipe(
      Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
    );

  return yield* prepareChildren(children, context).pipe(
    Effect.flatMap((plans) => commitChildren(plans, context, record)),
    Effect.catchTag("ChildRefused", (failure) => refuseChild(failure, record))
  );
});

const batchConfirmation = Effect.fn(function* (call: Call) {
  return "oauth" in call.subject
    ? yield* confirmLocalOAuth(call.subject.oauth, call.current, charge(call))
    : { paid: false, consume: Effect.void };
});

const resolveBatchChildren = <E, R>(
  children: ReadonlyArray<SelectedChild<Prepare | ReservedOwner<E, R>>>
): Effect.Effect<ReadonlyArray<Child>, E, R> =>
  Effect.forEach(children, (child) =>
    Predicate.isFunction(child.prepare)
      ? Effect.succeed({
          callId: child.callId,
          operation: child.operation,
          input: child.input,
          index: child.index,
          prepare: child.prepare,
        })
      : Effect.map(child.prepare.reserve(child.input), (prepare) => ({
          callId: child.callId,
          operation: child.operation,
          input: child.input,
          index: child.index,
          prepare,
        }))
  );

const commitAuthorizedBatch = Effect.fn(function* <E, R, ReserveE, ReserveR>(
  call: Call,
  {
    children,
    invocation,
    admitGrowth,
    reserve,
  }: {
    children: ReadonlyArray<SelectedChild<Prepare | ReservedOwner<E, R>>>;
    invocation: Invocation;
    admitGrowth: Effect.Effect<void, StoreCapacityUnavailable>;
    reserve: Effect.Effect<void, ReserveE, ReserveR>;
  }
) {
  const denied = yield* childAccess(call, children);

  if (Option.isSome(denied)) return denied.value;
  const confirmation = yield* batchConfirmation(call);

  if (isResponse(confirmation)) return attachStanding({ ...call, response: confirmation });
  yield* sweepLocalReceipts(call.current);
  const prior = yield* replay(call, invocation);

  if (Option.isSome(prior)) return prior.value;
  const refused = confirmation.paid ? Option.none<Response>() : yield* charge(call);

  if (Option.isSome(refused)) return refused.value;

  if (children.some((child) => requiresGrowthAdmission(child.operation.id))) yield* admitGrowth;
  yield* reserve;
  const resolved = yield* resolveBatchChildren(children);
  const outcome = yield* catchRejection(applyChildren(call, resolved));

  if (outcome.status < firstFailureStatus) yield* confirmation.consume;

  return yield* complete(call, invocation, {
    ...outcome,
    retain: children.every((child) => replayableBatchChild(child.operation.id)),
  });
});

const reserveRoutes = Effect.fn(function* (
  unit: Unit,
  children: Option.Option<Selection<unknown>>
) {
  if (Option.isSome(children) && "children" in children.value) {
    const selected = children.value.children.find(
      (child) => child.operation.id === "ingestion.enableEmailForwarding"
    );

    if (selected !== undefined) {
      const current = yield* Clock.currentTimeMillis;
      const resolve = yield* localProof(unit.request, unit.owns);
      const preliminary = yield* resolve(current);

      if (Predicate.isString(preliminary)) return;
      const caller = yield* childCaller({ subject: preliminary, current });
      const status = yield* localStanding(preliminary.userId, current);

      if (
        children.value.children.every(
          (child) =>
            OperationAccessDecision.$is("Allowed")(
              decideOperationAccess(child.operation.policy.access, caller)
            ) &&
            grantsRequiredTier({
              requiredTier: child.operation.policy.requiredTier,
              callerTier: status.accessTier,
            })
        )
      ) {
        yield* unit.reserveChildRoute(preliminary.userId);
      }
    }
  }
});

const prepareBatch = Effect.fn(function* <E, R>(
  unit: Unit,
  owners: ReadonlyMap<string, Prepare | ReservedOwner<E, R>>
) {
  const decoded = yield* boundedJsonBodyWithSize({
    request: unit.request,
    policy: bodyPolicy,
    schema: envelope,
  });

  const input = Option.map(
    Option.filter(decoded, ({ value, byteLength }) => withinEnvelopeLimit(value, byteLength)),
    ({ value }) => value
  );

  const rawKey = yield* localRetryKey(unit.request);
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

  const selected = Option.isSome(validInput)
    ? selectChildren({ calls: validInput.value.calls, owners, allowed: () => true })
    : ({ invalid: true } as const);

  const resolved = "children" in selected ? selected.children : [];

  return { validInput, selected, resolved, inputHash, digest };
});

export const runLocalBatch = Effect.fn(
  function* <E, R>(unit: Unit, owners: ReadonlyMap<string, Prepare | ReservedOwner<E, R>>) {
    const resolve = yield* localProof(unit.request, unit.owns);
    const { validInput, selected, resolved, inputHash, digest } = yield* prepareBatch(unit, owners);

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
          return yield* reject(call, invalid("Invalid atomic batch input."));
        }

        if ("invalid" in selected) {
          return yield* reject(call, invalid("Unknown canonical child operation."));
        }

        if ("refusal" in selected) {
          const attempted = { ...call, operation: selected.refusal.operation };
          yield* audit(attempted, selected.refusal.outcome);

          return attachStanding({
            ...call,
            response: rejectionResponse(childRejection(selected.refusal)),
          });
        }

        return yield* commitAuthorizedBatch(call, {
          children: resolved,
          invocation: { inputHash, digest },
          admitGrowth,
          reserve: reserveRoutes(unit, Option.some(selected)),
        });
      })
    );
  },
  Effect.tapCause(() =>
    Effect.logWarning({
      component: "canonical-admission",
      operation: "atomicBatch",
      outcome: "unavailable",
    })
  ),
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);
