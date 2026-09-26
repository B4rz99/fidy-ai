import {
  type AtomicBatchCall,
  AtomicBatchRejected,
  CanonicalOperationId,
  type CatalogOperation,
  type ErrorCode,
  decodeAtomicBatchResult,
  getAtomicBatchCallSchema,
  grantsRequiredTier,
  operationCatalog,
  patScopeCapability,
} from "@fidy/server/canonical-runtime";
import { Effect, Option, Schema } from "effect";
import { submissionInputBytes } from "../ingestion/statement-ingestion";
import { lostStatementReplay } from "../ingestion/statement-staging";
import type { HostedInference } from "@fidy/server/hosted-inference";
import {
  type CanonicalRefusalDisposition,
  type TransactionCaller,
  childCaller,
  isPATCaller,
  liveTransactionAuthority,
  liveTransactionCredential,
  maximumTransactionInputBytes,
  refusedCredentialResponse,
  rejectBatchEnvelope,
  rejectInvalidBatchInput,
  transactionNoStore,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import {
  type CanonicalMutationUnitExecution,
  committedMutationPayload,
  executeCanonicalMutationUnit,
} from "./canonical-mutation-unit";
import {
  type CanonicalMutationAdapter,
  canonicalMutationAdapter,
} from "./canonical-mutation-registry";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  PreparedCanonicalMutation,
} from "./mutation-types";
import { dailyAuditMessage } from "./transaction-outcome";

/** One raw child as the published batch mutation carries it; the catalog call schema decodes it. */
type CanonicalBatchCall = unknown;

type PreparedCall = Readonly<{
  _tag: "Prepared";
  call: AtomicBatchCall;
  operation: CatalogOperation;
  mutation: PreparedCanonicalMutation;
}>;
type CallStep =
  | PreparedCall
  | Readonly<{ _tag: "Response"; response: Response }>
  | Readonly<{ _tag: "CredentialRefused" }>;
type BatchPreparation =
  | Readonly<{ _tag: "Prepared"; children: ReadonlyArray<PreparedCall> }>
  | Readonly<{ _tag: "Response"; response: Response }>;
type CatalogDecision =
  | Readonly<{
      _tag: "Continue";
      operation: CatalogOperation;
      adapter: CanonicalMutationAdapter;
    }>
  | Readonly<{ _tag: "Response"; response: Response }>;

// A batch executes a call the caller already confirmed: hosted confirmation is enforced before a
// batch reaches this D1 seam, exactly as it is for an individual mutation, and no confirmation
// evidence exists at the D1 boundary either way.
//
// No Subscription adapter resolves AccessTier in this slice. Every implemented child is free-tier,
// and a Pro-only child is not implementable yet, so the stricter `free` default cannot admit work
// a Pro caller was owed.
const callerAccessTier = "free";
const executableChildMessage = "Each batch child must name an executable canonical mutation.";
const unsupportedChildMessage =
  "This canonical mutation has no batch adapter yet. Nothing was written; remove it or call it on its own.";
const paywallMessage = "The caller's Subscription tier does not grant this child mutation.";
const scopeMessage = "The caller's credential does not grant this child mutation's scope.";
const repeatedCallIdMessage =
  "Each child call needs its own callId; a repeated identity cannot commit twice.";
const repeatedTargetMessage =
  "Each child must address its own retained rule or Memory; one retained row cannot commit twice.";
export const oversizedChildMessage =
  "This child's input exceeds the size an individual call of this operation accepts.";
const maximumChildInputBytes = Math.min(maximumTransactionInputBytes, submissionInputBytes);
const childInputBytes = (call: unknown): number => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.Unknown }))(call);
  return new TextEncoder().encode(
    JSON.stringify(Option.isNone(decoded) ? call : decoded.value.input)
  ).length;
};

const batchRejection = ({
  code,
  message,
  index,
  operation,
}: Readonly<{
  code: ErrorCode;
  message: string;
  index: number;
  operation: CanonicalOperationId;
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

/**
 * Read the canonical operation one raw child names before the catalog call schema decodes it.
 * The read stays lenient on purpose: only a decodable operation can be attributed to a child.
 */
export const rawOperation = (call: CanonicalBatchCall): Option.Option<CanonicalOperationId> =>
  Option.flatMap(
    Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(call),
    (raw) => Schema.decodeOption(CanonicalOperationId)(raw.operation)
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
  return liveTransactionAuthority({ db, subject: scoped, current }).then((allowed) => {
    if (allowed) return "allowed" as const;
    if (!isPATCaller(subject)) return "credential_refused" as const;
    return liveTransactionCredential({ db, subject, current }).then((live) =>
      live ? ("scope_missing" as const) : ("credential_refused" as const)
    );
  });
};

/**
 * Map one already-recorded refusal disposition to the child-addressed batch failure contract.
 * `index` and `operation` name the child the refusal belongs to.
 */
const recordedRefusalResponse = ({
  db,
  subject,
  index,
  operation,
  refusal,
  disposition,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  index: number;
  operation: CanonicalOperationId;
  refusal: CanonicalMutationRefusal;
  disposition: CanonicalRefusalDisposition;
}>): Effect.Effect<Response> => {
  if (disposition === "credential_refused") return refusedCredentialResponse({ db, subject });
  if (disposition === "rate_limited") {
    return Effect.succeed(
      batchRejection({ code: "rate_limited", message: dailyAuditMessage, index, operation })
    );
  }
  if (disposition === "unavailable") return Effect.succeed(transactionUnavailable());
  return Effect.succeed(
    batchRejection({ code: refusal.code, message: refusal.message, index, operation })
  );
};

/**
 * Record one refused child's own refusal evidence and map it to the batch failure contract. The
 * child's owner decides the code, the message, and what evidence a refusal owes.
 */
const rejectChild = ({
  db,
  subject,
  index,
  operation,
  refusal,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  index: number;
  operation: CanonicalOperationId;
  refusal: CanonicalMutationRefusal;
}>): Effect.Effect<Response> =>
  // `record` and `respond` never fail by contract; a future fallible refusal must widen the
  // contract first, failing to build here until every caller answers the new failure.
  refusal
    .record()
    .pipe(
      Effect.flatMap((disposition) =>
        recordedRefusalResponse({ db, subject, index, operation, refusal, disposition })
      )
    );

/**
 * Refuse and record one executable child whose callId or canonical input failed its published
 * schema, through the owner's own refusal vocabulary. The raw attempted input travels along so an
 * owner that classifies undecoded input (an unstable retained id, for example) answers exactly as
 * its individual entry point does.
 */
const rejectInvalidChild = ({
  db,
  subject,
  current,
  bucket,
  adapter,
  index,
  operation,
  input,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  adapter: CanonicalMutationAdapter;
  bucket: Option.Option<R2Bucket>;
  index: number;
  operation: CanonicalOperationId;
  input: unknown;
}>): Effect.Effect<CallStep> =>
  rejectChild({
    db,
    subject,
    index,
    operation,
    refusal: adapter.invalidRefusal({ db, subject, current, input, bucket }),
  }).pipe(Effect.map((response) => ({ _tag: "Response" as const, response })));

/** The canonical input one malformed child attempted; an unshaped envelope remains raw input. */
const rawChildInput = (call: CanonicalBatchCall): unknown =>
  Option.getOrElse(
    Option.map(
      Schema.decodeUnknownOption(Schema.Struct({ input: Schema.Unknown }))(call),
      (envelope) => envelope.input
    ),
    () => call
  );

/** Decide one named canonical operation against the batch's own executable-child policy. */
const catalogDecision = (operation: CanonicalOperationId, index: number): CatalogDecision => {
  const catalogOperation = operationCatalog.byId.get(operation);
  if (catalogOperation === undefined) {
    return { _tag: "Response", response: rejectInvalidBatchInput() };
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
  const adapter = canonicalMutationAdapter(catalogOperation.id);
  if (Option.isNone(adapter)) {
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
      callerTier: callerAccessTier,
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
  return { _tag: "Continue", operation: catalogOperation, adapter: adapter.value };
};

const scopeStep = (
  access: ChildAccess,
  operation: CatalogOperation,
  index: number
): Option.Option<CallStep> => {
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

const failedCallStep = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<CallStep> =>
  Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })).pipe(
    Effect.orElseSucceed(() => false),
    Effect.map((live) =>
      live
        ? { _tag: "Response" as const, response: transactionUnavailable() }
        : { _tag: "CredentialRefused" as const }
    )
  );

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
}>): Effect.Effect<Option.Option<CallStep>> => {
  const capability = patScopeCapability(catalogOperation.policy.access);
  return Effect.tryPromise(() => childAccess({ db, subject, current, capability })).pipe(
    Effect.orElseSucceed(() => "credential_refused" as const),
    Effect.map((access) => scopeStep(access, catalogOperation, index))
  );
};

/** Map one owner preparation to its batch step, recording the evidence of an owner refusal. */
const preparationStep = ({
  db,
  scopedSubject,
  current,
  index,
  call,
  catalogOperation,
  preparation,
}: Readonly<{
  db: D1Database;
  scopedSubject: TransactionCaller;
  current: number;
  index: number;
  call: AtomicBatchCall;
  catalogOperation: CatalogOperation;
  preparation: CanonicalMutationPreparation;
}>): Effect.Effect<CallStep> => {
  switch (preparation._tag) {
    case "Prepared":
      return Effect.succeed({
        _tag: "Prepared",
        call,
        operation: catalogOperation,
        mutation: preparation.mutation,
      });
    case "CredentialRefused":
      return Effect.succeed({ _tag: "CredentialRefused" });
    case "Unavailable":
      return Effect.succeed({ _tag: "Response", response: transactionUnavailable() });
    case "Failed":
      return failedCallStep({ db, subject: scopedSubject, current });
    case "Refused":
      // The refusal Audit belongs to the same child authority the owner prepared under.
      return rejectChild({
        db,
        subject: scopedSubject,
        index,
        operation: catalogOperation.id,
        refusal: preparation.refusal,
      }).pipe(Effect.map((response) => ({ _tag: "Response" as const, response })));
  }
};

const oversizedChild = (
  call: CanonicalBatchCall,
  index: number,
  operation: CanonicalOperationId
): Option.Option<Extract<CallStep, { _tag: "Response" }>> =>
  childInputBytes(call) > maximumChildInputBytes
    ? Option.some({
        _tag: "Response",
        response: batchRejection({
          code: "validation_failed",
          message: oversizedChildMessage,
          index,
          operation,
        }),
      })
    : Option.none();

const decodedDecision = (call: CanonicalBatchCall, index: number): CatalogDecision => {
  const operation = rawOperation(call);
  if (Option.isNone(operation)) return { _tag: "Response", response: rejectInvalidBatchInput() };
  const decision = catalogDecision(operation.value, index);
  if (decision._tag === "Response") return decision;
  const oversized = oversizedChild(call, index, decision.operation.id);
  return Option.isSome(oversized)
    ? { _tag: "Response", response: oversized.value.response }
    : decision;
};

const unattributedOperation = (call: CanonicalBatchCall): boolean => {
  const named = rawOperation(call);
  return Option.isNone(named) || !operationCatalog.byId.has(named.value);
};

const rejectUnattributed = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<Response> =>
  Effect.tryPromise(() => rejectBatchEnvelope({ db, subject, current })).pipe(
    Effect.orElseSucceed(transactionUnavailable)
  );

const prepareCall = ({
  db,
  subject,
  call,
  index,
  current,
  bucket,
}: Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  subject: TransactionCaller;
  call: CanonicalBatchCall;
  index: number;
  current: number;
}>): Effect.Effect<CallStep, never, HostedInference> => {
  const decision = decodedDecision(call, index);
  if (decision._tag === "Response") {
    return Effect.succeed(decision);
  }
  const catalogOperation = decision.operation;
  return Effect.gen(function* () {
    const accessStep = yield* childAccessStep({ db, subject, current, catalogOperation, index });
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
        adapter: decision.adapter,
        bucket,
        index,
        operation: decision.operation.id,
        input: rawChildInput(call),
      });
    }
    const preparation = yield* decision.adapter.prepare({
      db,
      subject: scopedSubject,
      current,
      input: decodedCall.value.input,
      bucket,
    });
    return yield* preparationStep({
      db,
      scopedSubject,
      current,
      index,
      call: decodedCall.value,
      catalogOperation,
      preparation,
    });
  });
};

/** Compare raw callIds before schema validation so a repeated identity is a request-shape failure. */
const duplicateCallIndex = (calls: ReadonlyArray<CanonicalBatchCall>): Option.Option<number> => {
  const seen = new Set<string>();
  for (const [index, call] of calls.entries()) {
    const callId = Schema.decodeUnknownOption(Schema.Struct({ callId: Schema.String }))(call);
    if (Option.isNone(callId)) continue;
    if (seen.has(callId.value.callId)) return Option.some(index);
    seen.add(callId.value.callId);
  }
  return Option.none();
};

const duplicateRejection = (calls: ReadonlyArray<CanonicalBatchCall>, index: number): Response => {
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

/**
 * The retained row one prepared child addresses, when a second child must not address it again.
 * Transaction children carry their own revision and pair guards, so only keyword-rule and Memory
 * children need an explicit one-target-per-batch rule; a capture or remember mints a fresh id and
 * never collides.
 */
const childTarget = (mutation: PreparedCanonicalMutation): Option.Option<string> => {
  const outcome = mutation.outcome;
  if (outcome._tag === "KeywordRule") return Option.some(`keyword-rule:${outcome.ruleId}`);
  if (outcome._tag === "Memory") return Option.some(`memory:${outcome.memoryId}`);
  if (outcome._tag === "StatementSubmission") return Option.some("statement-publication");
  return Option.none();
};

const prepareBatch = ({
  db,
  subject,
  calls,
  current,
  bucket,
}: Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  subject: TransactionCaller;
  calls: ReadonlyArray<CanonicalBatchCall>;
  current: number;
}>): Effect.Effect<BatchPreparation, never, HostedInference> =>
  Effect.gen(function* () {
    const children: Array<PreparedCall> = [];
    const targets = new Set<string>();
    for (const [index, call] of calls.entries()) {
      const step = yield* prepareCall({ db, subject, call, index, current, bucket });
      if (step._tag === "Response") return { _tag: "Response", response: step.response };
      if (step._tag === "CredentialRefused") {
        return { _tag: "Response", response: yield* refusedCredentialResponse({ db, subject }) };
      }
      const target = childTarget(step.mutation);
      if (Option.isSome(target)) {
        // Two children that address one retained row cannot both present independent results, and
        // the owner guards do not serialize them, so the batch refuses before any child commits.
        if (targets.has(target.value)) {
          return {
            _tag: "Response",
            response: batchRejection({
              code: "validation_failed",
              message: repeatedTargetMessage,
              index,
              operation: step.operation.id,
            }),
          };
        }
        targets.add(target.value);
      }
      children.push(step);
    }
    return { _tag: "Prepared", children };
  });

const presentCommitted = ({
  children,
  execution,
}: Readonly<{
  children: ReadonlyArray<PreparedCall>;
  execution: Extract<CanonicalMutationUnitExecution, { readonly _tag: "Committed" }>;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const results: Array<Readonly<{ callId: string; operation: string; output: unknown }>> = [];
    for (const [index, child] of children.entries()) {
      const value = execution.values[index];
      if (value === undefined) return transactionUnavailable();
      // Every child presents the same canonical success value its individual response would.
      const result = yield* decodeAtomicBatchResult({
        callId: child.call.callId,
        operation: child.operation.id,
        output: { data: committedMutationPayload(value), next: [] },
      });
      const output = yield* Schema.encodeEffect(child.operation.success)(result.output);
      results.push({ callId: result.callId, operation: result.operation, output });
    }
    return Response.json({ data: { results }, next: [] }, { headers: transactionNoStore });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

/** Map one rejected unit execution to the child-addressed batch failure contract. */
const rejectedBatchResponse = ({
  db,
  subject,
  children,
  execution,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  children: ReadonlyArray<PreparedCall>;
  execution: Extract<CanonicalMutationUnitExecution, { readonly _tag: "Rejected" }>;
}>): Effect.Effect<Response> => {
  const child = children[execution.callIndex];
  if (child === undefined) return Effect.succeed(transactionUnavailable());
  return recordedRefusalResponse({
    db,
    subject,
    index: execution.callIndex,
    operation: child.operation.id,
    refusal: execution.refusal,
    disposition: execution.disposition,
  });
};

const executionResponse = ({
  db,
  subject,
  children,
  execution,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  children: ReadonlyArray<PreparedCall>;
  execution: CanonicalMutationUnitExecution;
}>): Effect.Effect<Response> => {
  switch (execution._tag) {
    case "Committed":
      return presentCommitted({ children, execution });
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
    case "Aborted":
      return Effect.succeed(transactionUnavailable());
    case "Rejected":
      return rejectedBatchResponse({ db, subject, children, execution });
  }
};

const needsEnvelopeAudit = (calls: ReadonlyArray<CanonicalBatchCall>): boolean => {
  const firstUnattributed = calls.findIndex(unattributedOperation);
  if (firstUnattributed < 0) return false;
  return !calls.slice(0, firstUnattributed).some((call) => {
    const named = rawOperation(call);
    return Option.isSome(named) && Option.isSome(canonicalMutationAdapter(named.value));
  });
};

const preAdmissionResponse = ({
  db,
  subject,
  calls,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  calls: ReadonlyArray<CanonicalBatchCall>;
  current: number;
}>): Option.Option<Effect.Effect<Response>> => {
  const duplicate = duplicateCallIndex(calls);
  if (Option.isSome(duplicate)) {
    return Option.some(Effect.succeed(duplicateRejection(calls, duplicate.value)));
  }
  return needsEnvelopeAudit(calls)
    ? Option.some(rejectUnattributed({ db, subject, current }))
    : Option.none();
};

/**
 * Execute one decoded canonical atomic batch under live caller authority. Every child keeps the
 * individual operation's validation, authorization, domain, and metadata-only Audit decisions;
 * all children commit in one D1 unit under one User coordination turn or none do. Unsupported
 * children fail closed before the unit is attempted.
 */
export const executeCanonicalBatch = ({
  db,
  subject,
  calls,
  current,
  bucket,
}: Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  subject: TransactionCaller;
  calls: ReadonlyArray<CanonicalBatchCall>;
  current: number;
}>): Effect.Effect<Response, never, HostedInference> =>
  Effect.gen(function* () {
    const preAdmission = preAdmissionResponse({ db, subject, calls, current });
    if (Option.isSome(preAdmission)) return yield* preAdmission.value;
    const batch = yield* prepareBatch({ db, subject, calls, current, bucket });
    if (batch._tag === "Response") return batch.response;
    const execution = yield* executeCanonicalMutationUnit({
      db,
      subject,
      current,
      mutations: batch.children.map((child) => child.mutation),
    });
    if (execution._tag === "Aborted") {
      const statement = batch.children.find(
        (child) => child.mutation.outcome._tag === "StatementSubmission"
      );
      if (
        statement?.mutation.outcome._tag === "StatementSubmission" &&
        (yield* lostStatementReplay(
          statement.mutation.outcome.config,
          statement.mutation.outcome.publication
        ))
      ) {
        const replay = yield* prepareBatch({ db, subject, calls, current, bucket });
        if (replay._tag === "Response") return replay.response;
        const retried = yield* executeCanonicalMutationUnit({
          db,
          subject,
          current,
          mutations: replay.children.map((child) => child.mutation),
        });
        return yield* executionResponse({
          db,
          subject,
          children: replay.children,
          execution: retried,
        });
      }
    }
    return yield* executionResponse({ db, subject, children: batch.children, execution });
  });
