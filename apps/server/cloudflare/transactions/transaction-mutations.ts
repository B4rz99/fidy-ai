import {
  type AtomicBatchCall,
  AtomicBatchRejected,
  CanonicalOperationId,
  type CatalogOperation,
  CreateTransactionCanonicalInput,
  type ErrorCode,
  UpdateTransactionCanonicalInput,
  decodeAtomicBatchResult,
  getAtomicBatchCallSchema,
  grantsRequiredTier,
  operationCatalog,
  patScopeCapability,
} from "@fidy/server/canonical-runtime";
import type {
  CreateTransactionInput,
  UpdateTransactionInput,
} from "@fidy/server/transactions-runtime";
import { Effect, Option, Schema } from "effect";
import {
  type TransactionCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  childCaller,
  isPATCaller,
  liveTransactionCaller,
  liveTransactionCredential,
  recordTransactionRefusal,
  refusalFailureCode,
  refusedCredentialResponse,
  rejectInvalidBatchInput,
  transactionNoStore,
  transactionUnavailable,
} from "./transaction-boundary";
import {
  type PreparedTransactionMutation,
  type TransactionMutationPreparation,
  type TransactionUnitExecution,
  dailyAuditMessage,
  executeTransactionUnit,
} from "./transaction-unit";
import { prepareCapture } from "./transactions";
import { prepareCorrection } from "./transaction-corrections";

// The catalog-derived call schema already validated each child's canonical input; these accept
// the decoded canonical input so the batch only extracts the typed payload the owner prepares.
const CaptureInput = Schema.toType(CreateTransactionCanonicalInput);
const CorrectionInput = Schema.toType(UpdateTransactionCanonicalInput);

/** One raw child as the published batch command carries it; the catalog call schema decodes it. */
export type TransactionBatchCall = unknown;

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

type PreparedChild = Readonly<{
  _tag: "Prepared";
  call: AtomicBatchCall;
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
  | Readonly<{
      _tag: "Continue";
      operation: CatalogOperation;
      mutation: TransactionMutationOperation;
    }>
  | Readonly<{ _tag: "Response"; response: Response }>;

// A batch executes a call the caller already confirmed: hosted confirmation is enforced before a
// batch reaches this D1 seam, exactly as it is for an individual mutation, and no confirmation
// evidence exists at the D1 boundary either way.
//
// No Subscription adapter resolves AccessTier in this slice. Every implemented child is free-tier,
// and a Pro-only child is not implementable yet, so the stricter `free` default cannot admit work
// a Pro caller was owed.
const transactionAccessTier = "free";
const executableChildMessage = "Each batch child must name an executable canonical mutation.";
const unsupportedChildMessage =
  "This canonical mutation has no Transaction batch adapter yet. Nothing was written; remove it or call it on its own.";
const paywallMessage = "The caller's Subscription tier does not grant this child mutation.";
const scopeMessage = "The caller's credential does not grant this child mutation's scope.";
const invalidChildMessage = "Invalid input for this child mutation.";
const repeatedCallIdMessage =
  "Each child call needs its own callId; a repeated identity cannot commit twice.";
/** The only canonical mutations this adapter composes; every other child fails closed. */
const implementedMutations: ReadonlySet<string> = new Set<TransactionMutationOperation>([
  "transactions.createTransaction",
  "transactions.updateTransaction",
]);
const isImplementedMutation = (id: string): id is TransactionMutationOperation =>
  implementedMutations.has(id);

const decodeChild = (operation: string, input: unknown): Option.Option<DecodedChild> => {
  if (operation === "transactions.createTransaction") {
    return Option.map(Schema.decodeUnknownOption(CaptureInput)(input), (value) => ({
      _tag: "Capture" as const,
      operation: "transactions.createTransaction" as const,
      input: value.payload,
    }));
  }
  if (operation === "transactions.updateTransaction") {
    return Option.map(Schema.decodeUnknownOption(CorrectionInput)(input), (value) => ({
      _tag: "Correction" as const,
      operation: "transactions.updateTransaction" as const,
      id: value.params.id,
      input: value.payload,
    }));
  }
  return Option.none();
};

/**
 * Read the canonical operation one raw child names before the catalog call schema decodes it.
 * The read stays lenient on purpose: only a decodable operation can be attributed to a child.
 */
const rawOperation = (call: TransactionBatchCall): Option.Option<CanonicalOperationId> =>
  Option.flatMap(
    Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(call),
    (raw) => Schema.decodeOption(CanonicalOperationId)(raw.operation)
  );

const batchRejection = ({
  code,
  message,
  index,
  operation,
}: Readonly<{
  code: ErrorCode;
  message: string;
  index: number;
  operation: CanonicalOperationId | TransactionMutationOperation;
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
  const scoped = childCaller(subject, capability);
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
  refusal: TransactionRefusal;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const record = yield* Effect.tryPromise(() =>
      recordTransactionRefusal({
        db,
        subject,
        outcome: refusal.outcome,
        operation,
        current,
      })
    );
    if (record === "credential_refused") {
      return yield* refusedCredentialResponse({ db, subject });
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
      code: refusalFailureCode(refusal.outcome),
      message: refusal.message,
      index,
      operation,
    });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const preparedChild = (
  call: AtomicBatchCall,
  operation: CatalogOperation,
  mutation: PreparedTransactionMutation
): PreparedChild => ({ _tag: "Prepared", call, operation, mutation });

/** Decide one named canonical operation against the batch's own executable-child policy. */
const catalogDecision = (operation: CanonicalOperationId, index: number): CatalogDecision => {
  const catalogOperation = operationCatalog.byId.get(operation);
  if (catalogOperation === undefined) {
    return { _tag: "Response", response: transactionUnavailable() };
  }
  if (catalogOperation.policy.kind !== "mutation") {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "validation_failed",
        message: executableChildMessage,
        index,
        operation: catalogOperation.id,
      }),
    };
  }
  if (!isImplementedMutation(catalogOperation.id)) {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "unavailable",
        message: unsupportedChildMessage,
        index,
        operation: catalogOperation.id,
      }),
    };
  }
  if (
    !grantsRequiredTier({
      requiredTier: catalogOperation.policy.requiredTier,
      callerTier: transactionAccessTier,
    })
  ) {
    return {
      _tag: "Response",
      response: batchRejection({
        code: "paywall_required",
        message: paywallMessage,
        index,
        operation: catalogOperation.id,
      }),
    };
  }
  return { _tag: "Continue", operation: catalogOperation, mutation: catalogOperation.id };
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
  scopedSubject,
  current,
  index,
  call,
  catalogOperation,
  decoded,
  preparation,
}: Readonly<{
  db: D1Database;
  scopedSubject: TransactionCaller;
  current: number;
  index: number;
  call: AtomicBatchCall;
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
    return failedChildStep({ db, subject: scopedSubject, current });
  }
  // The refusal Audit belongs to the same child authority the owner prepared under.
  return rejectChild({
    db,
    subject: scopedSubject,
    current,
    index,
    operation: decoded.operation,
    refusal: preparation.refusal,
  }).pipe(Effect.map((response) => ({ _tag: "Response" as const, response })));
};

/** Refuse and audit one executable child whose callId or canonical input failed its schema. */
const rejectInvalidChild = ({
  db,
  subject,
  current,
  index,
  operation,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  index: number;
  operation: TransactionMutationOperation;
}>): Effect.Effect<ChildStep> =>
  rejectChild({
    db,
    subject,
    current,
    index,
    operation,
    refusal: { outcome: "validation_failed", message: invalidChildMessage },
  }).pipe(Effect.map((response) => ({ _tag: "Response" as const, response })));

/** Recheck one child's live authority and report the refusal reason when it is not allowed. */
const childAccessStep = ({
  db,
  subject,
  current,
  catalogOperation,
  index,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  catalogOperation: CatalogOperation;
  index: number;
}>): Effect.Effect<Option.Option<ChildStep>> => {
  const capability = patScopeCapability(catalogOperation.policy.access);
  return Effect.tryPromise(() => childAccess({ db, subject, current, capability })).pipe(
    Effect.orElseSucceed(() => "credential_refused" as const),
    Effect.map((access) => scopeStep(access, catalogOperation, index))
  );
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
  const operation = rawOperation(call);
  if (Option.isNone(operation)) {
    // Structurally absent children are answered as the request-level validation failure they are.
    return Effect.succeed({ _tag: "Response", response: rejectInvalidBatchInput() });
  }
  const decision = catalogDecision(operation.value, index);
  if (decision._tag === "Response") return Effect.succeed(decision);
  const catalogOperation = decision.operation;
  return Effect.gen(function* () {
    const accessStep = yield* childAccessStep({
      db,
      subject,
      current,
      catalogOperation,
      index,
    });
    if (Option.isSome(accessStep)) return accessStep.value;
    const capability = patScopeCapability(catalogOperation.policy.access);
    const scopedSubject = childCaller(subject, capability);
    const decodedCall = Schema.decodeUnknownOption(getAtomicBatchCallSchema())(call);
    if (Option.isNone(decodedCall)) {
      // The child names an executable mutation, so its own callId or input failed the published
      // schema: refuse and audit that child instead of failing the whole request unattributed.
      return yield* rejectInvalidChild({
        db,
        subject: scopedSubject,
        current,
        index,
        operation: decision.mutation,
      });
    }
    return yield* prepareDecodedCall({
      db,
      scopedSubject,
      current,
      index,
      catalogOperation,
      mutation: decision.mutation,
      decodedCall: decodedCall.value,
    });
  });
};

/** Decode one catalog-validated child into its owner payload and hand it to the owner adapter. */
const prepareDecodedCall = ({
  db,
  scopedSubject,
  current,
  index,
  catalogOperation,
  mutation,
  decodedCall,
}: Readonly<{
  db: D1Database;
  scopedSubject: TransactionCaller;
  current: number;
  index: number;
  catalogOperation: CatalogOperation;
  mutation: TransactionMutationOperation;
  decodedCall: AtomicBatchCall;
}>): Effect.Effect<ChildStep> =>
  Effect.gen(function* () {
    const decoded = decodeChild(mutation, decodedCall.input);
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
    const preparation = yield* prepareDecodedChild({
      db,
      subject: scopedSubject,
      decoded: decoded.value,
      current,
    });
    return yield* preparationStep({
      db,
      scopedSubject,
      current,
      index,
      call: decodedCall,
      catalogOperation,
      decoded: decoded.value,
      preparation,
    });
  });

/** Compare raw callIds before schema validation so a repeated identity is a request-shape failure. */
const duplicateCallIndex = (calls: ReadonlyArray<TransactionBatchCall>): Option.Option<number> => {
  const seen = new Set<string>();
  for (const [index, call] of calls.entries()) {
    const callId = Schema.decodeUnknownOption(Schema.Struct({ callId: Schema.String }))(call);
    if (Option.isNone(callId)) continue;
    if (seen.has(callId.value.callId)) return Option.some(index);
    seen.add(callId.value.callId);
  }
  return Option.none();
};

const duplicateRejection = (
  calls: ReadonlyArray<TransactionBatchCall>,
  index: number
): Response => {
  const operation = rawOperation(calls[index]);
  return Option.isSome(operation)
    ? batchRejection({
        code: "validation_failed",
        message: repeatedCallIdMessage,
        index,
        operation: operation.value,
      })
    : rejectInvalidBatchInput();
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
        return { _tag: "Response", response: yield* refusedCredentialResponse({ db, subject }) };
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
      // Revalidate each result against the published correlated union before it is encoded.
      const result = yield* decodeAtomicBatchResult({
        callId: child.call.callId,
        operation: child.operation.id,
        output: { data: stored, next: [] },
      });
      const output = yield* Schema.encodeEffect(child.operation.success)(result.output);
      results.push({ callId: result.callId, operation: result.operation, output });
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
  if (execution._tag === "CredentialRefused") return refusedCredentialResponse({ db, subject });
  if (execution._tag === "Unavailable") return Effect.succeed(transactionUnavailable());
  const child = children[execution.callIndex];
  return Effect.succeed(
    child === undefined
      ? transactionUnavailable()
      : batchRejection({
          code: refusalFailureCode(execution.refusal.outcome),
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
