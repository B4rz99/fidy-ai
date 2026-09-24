import {
  AtomicBatchRejected,
  CanonicalOperationId,
  type CatalogOperation,
  grantsRequiredTier,
  operationCatalog,
  patScopeCapability,
} from "@fidy/server/canonical-runtime";
import {
  CreateTransactionInput,
  TransactionId,
  UpdateTransactionInput,
} from "@fidy/server/transactions-runtime";
import { Effect, Option, Schema } from "effect";
import {
  type TransactionCaller,
  type TransactionMutationOperation,
  isPATCaller,
  liveTransactionCaller,
  liveTransactionCredential,
  recordTransactionRefusal,
  refusedTransactionWork,
  transactionNoStore,
  transactionUnavailable,
} from "./transaction-boundary";
import {
  type PreparedTransactionMutation,
  type TransactionMutationPreparation,
  type TransactionUnitExecution,
  executeTransactionUnit,
} from "./transaction-unit";
import { prepareCapture } from "./transactions";
import { prepareCorrection } from "./transaction-corrections";

/** The canonical input each implemented Transaction mutation is submitted with inside a batch. */
const CreateTransactionCall = Schema.toCodecJson(
  Schema.Struct({ payload: CreateTransactionInput })
);
const UpdateTransactionCall = Schema.toCodecJson(
  Schema.Struct({
    params: Schema.Struct({ id: TransactionId }),
    payload: UpdateTransactionInput,
  })
);

/** One canonical child call of an atomic batch, exactly as the public contract encodes it. */
export type TransactionBatchCall = Readonly<{
  callId: string;
  operation: string;
  input: unknown;
}>;

type DecodedChild =
  | Readonly<{
      _tag: "Capture";
      operation: "transactions.createTransaction";
      input: CreateTransactionInput;
    }>
  | Readonly<{
      _tag: "Correction";
      operation: "transactions.updateTransaction";
      id: string;
      input: UpdateTransactionInput;
    }>;

type RefusedPreparation = Extract<TransactionMutationPreparation, { readonly _tag: "Refused" }>;
type PreparedChild = Readonly<{
  _tag: "Prepared";
  call: TransactionBatchCall;
  operation: CatalogOperation;
  mutation: PreparedTransactionMutation;
}>;
type ChildStep =
  | PreparedChild
  | Readonly<{ _tag: "Response"; response: Response }>
  | Readonly<{ _tag: "CredentialRefused" }>;
type BatchPreparation =
  | Readonly<{ _tag: "Prepared"; children: ReadonlyArray<PreparedChild> }>
  | Readonly<{ _tag: "Response"; response: Response }>;
type CatalogDecision =
  | Readonly<{ _tag: "Continue"; operation: CatalogOperation }>
  | Readonly<{ _tag: "Response"; response: Response }>;

// No Subscription adapter resolves AccessTier in this slice. Every implemented child is free-tier,
// and a Pro-only child is not implementable yet, so the stricter `free` default cannot admit work
// a Pro caller was owed.
const transactionAccessTier = "free";
const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";
const executableChildMessage = "Each batch child must name an executable canonical mutation.";
const unsupportedChildMessage =
  "This canonical mutation has no Transaction batch adapter yet. Nothing was written; remove it or call it on its own.";
const paywallMessage = "The caller's Subscription tier does not grant this child mutation.";
const scopeMessage = "The caller's credential does not grant this child mutation's scope.";
const invalidChildMessage = "Invalid input for this child mutation.";
const repeatedCallIdMessage =
  "Each child call needs its own callId; a repeated identity cannot commit twice.";
/** The only canonical mutations this adapter composes; every other child fails closed. */
const implementedMutations: ReadonlySet<string> = new Set([
  "transactions.createTransaction",
  "transactions.updateTransaction",
]);

const decodeChild = (operation: string, input: unknown): Option.Option<DecodedChild> => {
  if (operation === "transactions.createTransaction") {
    return Option.map(Schema.decodeUnknownOption(CreateTransactionCall)(input), (value) => ({
      _tag: "Capture" as const,
      operation: "transactions.createTransaction" as const,
      input: value.payload,
    }));
  }
  if (operation === "transactions.updateTransaction") {
    return Option.map(Schema.decodeUnknownOption(UpdateTransactionCall)(input), (value) => ({
      _tag: "Correction" as const,
      operation: "transactions.updateTransaction" as const,
      id: value.params.id,
      input: value.payload,
    }));
  }
  return Option.none();
};

const batchRejectionCode = (
  outcome: RefusedPreparation["refusal"]["outcome"]
): "not_found" | "validation_failed" | "rate_limited" => {
  if (outcome === "not_found") return "not_found";
  if (outcome === "resource_limit") return "rate_limited";
  return "validation_failed";
};

const batchRejection = ({
  code,
  message,
  index,
  operation,
}: Readonly<{
  code:
    | "validation_failed"
    | "not_found"
    | "rate_limited"
    | "scope_missing"
    | "paywall_required"
    | "unavailable";
  message: string;
  index: number;
  operation: string;
}>): Response =>
  Response.json(
    Schema.encodeSync(Schema.toCodecJson(AtomicBatchRejected))(
      AtomicBatchRejected.make({
        error: {
          code,
          message,
          failedCallIndex: index,
          operation: CanonicalOperationId.make(operation),
          fields: [],
        },
        next: [],
      })
    ),
    { status: 400, headers: transactionNoStore }
  );

type ChildAccess = "allowed" | "scope_missing" | "credential_refused";

const childAccess = ({
  db,
  subject,
  current,
  capability,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  capability: ReturnType<typeof patScopeCapability>;
}>): Promise<ChildAccess> => {
  const scoped =
    isPATCaller(subject) && Option.isSome(capability)
      ? { ...subject, requiredScope: capability }
      : subject;
  return liveTransactionCaller({ db, subject: scoped, current }).then((allowed) => {
    if (allowed) return "allowed" as const;
    if (!isPATCaller(subject)) return "credential_refused" as const;
    return liveTransactionCredential({ db, subject, current }).then((live) =>
      live ? ("scope_missing" as const) : ("credential_refused" as const)
    );
  });
};

const rejectChild = ({
  db,
  subject,
  current,
  index,
  operation,
  refusal,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  index: number;
  operation: TransactionMutationOperation;
  refusal: RefusedPreparation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const record = yield* Effect.tryPromise(() =>
      recordTransactionRefusal({
        db,
        subject,
        outcome: refusal.refusal.outcome,
        operation,
        current,
      })
    );
    if (record === "credential_refused") {
      return yield* Effect.tryPromise(() => refusedTransactionWork({ db, subject }));
    }
    if (record === "unavailable") return transactionUnavailable();
    if (record === "rate_limited") {
      return batchRejection({
        code: "rate_limited",
        message: dailyAuditMessage,
        index,
        operation,
      });
    }
    return batchRejection({
      code: batchRejectionCode(refusal.refusal.outcome),
      message: refusal.refusal.message,
      index,
      operation,
    });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const credentialResponse = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Effect.Effect<Response> =>
  Effect.tryPromise(() => refusedTransactionWork({ db, subject })).pipe(
    Effect.orElseSucceed(transactionUnavailable)
  );

const preparedChild = (
  call: TransactionBatchCall,
  operation: CatalogOperation,
  mutation: PreparedTransactionMutation
): PreparedChild => ({ _tag: "Prepared", call, operation, mutation });

const catalogDecision = (call: TransactionBatchCall, index: number): CatalogDecision => {
  const operation = operationCatalog.byId.get(call.operation);
  if (operation === undefined) {
    const candidate = Schema.decodeOption(CanonicalOperationId)(call.operation);
    return Option.isSome(candidate)
      ? {
          _tag: "Response",
          response: batchRejection({
            code: "validation_failed",
            message: executableChildMessage,
            index,
            operation: candidate.value,
          }),
        }
      : { _tag: "Response", response: transactionUnavailable() };
  }
  if (operation.policy.kind !== "mutation") {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "validation_failed",
        message: executableChildMessage,
        index,
        operation: operation.id,
      }),
    };
  }
  if (!implementedMutations.has(operation.id)) {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "unavailable",
        message: unsupportedChildMessage,
        index,
        operation: operation.id,
      }),
    };
  }
  if (
    !grantsRequiredTier({
      requiredTier: operation.policy.requiredTier,
      callerTier: transactionAccessTier,
    })
  ) {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "paywall_required",
        message: paywallMessage,
        index,
        operation: operation.id,
      }),
    };
  }
  return { _tag: "Continue", operation };
};

const scopeStep = (
  access: ChildAccess,
  operation: CatalogOperation,
  index: number
): Option.Option<ChildStep> => {
  if (access === "allowed") return Option.none();
  if (access === "credential_refused") return Option.some({ _tag: "CredentialRefused" });
  return Option.some({
    _tag: "Response",
    response: batchRejection({
      code: "scope_missing",
      message: scopeMessage,
      index,
      operation: operation.id,
    }),
  });
};

const failedChildStep = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<ChildStep> =>
  Effect.tryPromise(() => liveTransactionCaller({ db, subject, current })).pipe(
    Effect.orElseSucceed(() => false),
    Effect.map((live) =>
      live
        ? { _tag: "Response" as const, response: transactionUnavailable() }
        : { _tag: "CredentialRefused" as const }
    )
  );

const prepareDecodedChild = ({
  db,
  subject,
  decoded,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  decoded: DecodedChild;
  current: number;
}>): Effect.Effect<TransactionMutationPreparation> =>
  decoded._tag === "Capture"
    ? prepareCapture({ db, subject, input: decoded.input, current })
    : prepareCorrection({ db, subject, id: decoded.id, input: decoded.input, current });

const preparationStep = ({
  db,
  subject,
  current,
  index,
  call,
  catalogOperation,
  decoded,
  preparation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  index: number;
  call: TransactionBatchCall;
  catalogOperation: CatalogOperation;
  decoded: DecodedChild;
  preparation: TransactionMutationPreparation;
}>): Effect.Effect<ChildStep> => {
  if (preparation._tag === "Prepared") {
    return Effect.succeed(preparedChild(call, catalogOperation, preparation.mutation));
  }
  if (preparation._tag === "CredentialRefused") {
    return Effect.succeed({ _tag: "CredentialRefused" });
  }
  if (preparation._tag === "Unavailable") {
    return Effect.succeed({ _tag: "Response", response: transactionUnavailable() });
  }
  if (preparation._tag === "Failed") {
    return failedChildStep({ db, subject, current });
  }
  return rejectChild({
    db,
    subject,
    current,
    index,
    operation: decoded.operation,
    refusal: preparation,
  }).pipe(Effect.map((response) => ({ _tag: "Response" as const, response })));
};

const prepareChild = ({
  db,
  subject,
  call,
  index,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  call: TransactionBatchCall;
  index: number;
  current: number;
}>): Effect.Effect<ChildStep> => {
  const decision = catalogDecision(call, index);
  if (decision._tag === "Response") return Effect.succeed(decision);
  const catalogOperation = decision.operation;
  return Effect.gen(function* () {
    const capability = patScopeCapability(catalogOperation.policy.access);
    const access = yield* Effect.tryPromise(() =>
      childAccess({ db, subject, current, capability })
    ).pipe(Effect.orElseSucceed(() => "credential_refused" as const));
    const accessStep = scopeStep(access, catalogOperation, index);
    if (Option.isSome(accessStep)) return accessStep.value;
    const decoded = decodeChild(call.operation, call.input);
    if (Option.isNone(decoded)) {
      return {
        _tag: "Response",
        response: batchRejection({
          code: "validation_failed",
          message: invalidChildMessage,
          index,
          operation: catalogOperation.id,
        }),
      };
    }
    const scopedSubject =
      isPATCaller(subject) && Option.isSome(capability)
        ? { ...subject, requiredScope: capability }
        : subject;
    const preparation = yield* prepareDecodedChild({
      db,
      subject: scopedSubject,
      decoded: decoded.value,
      current,
    });
    return yield* preparationStep({
      db,
      subject,
      current,
      index,
      call,
      catalogOperation,
      decoded: decoded.value,
      preparation,
    });
  });
};

const duplicateCallIndex = (calls: ReadonlyArray<TransactionBatchCall>): Option.Option<number> => {
  const seen = new Set<string>();
  for (const [index, call] of calls.entries()) {
    if (seen.has(call.callId)) return Option.some(index);
    seen.add(call.callId);
  }
  return Option.none();
};

const duplicateRejection = (
  calls: ReadonlyArray<TransactionBatchCall>,
  index: number
): Response => {
  const offending = calls[index];
  return offending === undefined
    ? transactionUnavailable()
    : batchRejection({
        code: "validation_failed",
        message: repeatedCallIdMessage,
        index,
        operation: offending.operation,
      });
};

const prepareBatch = ({
  db,
  subject,
  calls,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  calls: ReadonlyArray<TransactionBatchCall>;
  current: number;
}>): Effect.Effect<BatchPreparation> =>
  Effect.gen(function* () {
    const children: Array<PreparedChild> = [];
    for (const [index, call] of calls.entries()) {
      const step = yield* prepareChild({ db, subject, call, index, current });
      if (step._tag === "Response") return { _tag: "Response", response: step.response };
      if (step._tag === "CredentialRefused") {
        return { _tag: "Response", response: yield* credentialResponse({ db, subject }) };
      }
      children.push(step);
    }
    return { _tag: "Prepared", children };
  });

const presentCommitted = ({
  children,
  execution,
}: Readonly<{
  children: ReadonlyArray<PreparedChild>;
  execution: Extract<TransactionUnitExecution, { readonly _tag: "Committed" }>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const results: Array<Readonly<{ callId: string; operation: string; output: unknown }>> = [];
    for (const [index, child] of children.entries()) {
      const stored = execution.results[index];
      if (stored === undefined) return transactionUnavailable();
      const output = yield* Schema.encodeEffect(child.operation.success)({
        data: stored,
        next: [],
      });
      results.push({ callId: child.call.callId, operation: child.operation.id, output });
    }
    return Response.json({ data: { results }, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const executionResponse = ({
  db,
  subject,
  children,
  execution,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  children: ReadonlyArray<PreparedChild>;
  execution: TransactionUnitExecution;
}>): Effect.Effect<Response> => {
  if (execution._tag === "Committed") return presentCommitted({ children, execution });
  if (execution._tag === "CredentialRefused") return credentialResponse({ db, subject });
  if (execution._tag === "Unavailable") return Effect.succeed(transactionUnavailable());
  const child = children[execution.callIndex];
  return Effect.succeed(
    child === undefined
      ? transactionUnavailable()
      : batchRejection({
          code: batchRejectionCode(execution.refusal.outcome),
          message: execution.refusal.message,
          index: execution.callIndex,
          operation: child.operation.id,
        })
  );
};

/**
 * Execute one decoded canonical atomic batch under live caller authority. Every child keeps the
 * individual operation's validation, authorization, domain, and metadata-only Audit decisions;
 * all children commit in one D1 unit under one User coordination turn or none do. Unsupported
 * children fail closed before the unit is attempted.
 */
export const executeTransactionBatch = ({
  db,
  subject,
  calls,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  calls: ReadonlyArray<TransactionBatchCall>;
  current: number;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const duplicate = duplicateCallIndex(calls);
      if (Option.isSome(duplicate)) return duplicateRejection(calls, duplicate.value);
      const batch = yield* prepareBatch({ db, subject, calls, current });
      if (batch._tag === "Response") return batch.response;
      const execution = yield* executeTransactionUnit({
        db,
        subject,
        current,
        mutations: batch.children.map((child) => child.mutation),
      });
      return yield* executionResponse({ db, subject, children: batch.children, execution });
    })
  ).catch(() => transactionUnavailable());
