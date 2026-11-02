import { decideOperationAccess } from "../../../src/shell/canonical-policy/operations";
import { AtomicBatchAdmission, atomicBatchOperation } from "../../../src/shell/operations/contract";
import { executeHostedCanonicalBatch } from "./batch";
import {
  canonicalOperationRequiresInference,
  unreachableHostedInference,
} from "./inference-requirement";
import type { HostedInferenceService } from "../../../src/shell/hosted-inference/contract";
import type { CanonicalMutationPreparation, CommittedMutationValue } from "../contract";
import { HostedInference } from "../../../src/shell/hosted-inference/operations";
import { Effect, Option, Schema } from "effect";
import { operationCatalog } from "../../../src/shell/api";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import { transactionUnavailable } from "../../canonical-work/operations";
import type { HostedCommitFence } from "../../agent/contract";
import { canonicalHostedStatementQueryOwner } from "./query-registry";
import { canonicalHostedStatementAdapter } from "./mutation-registry";
import { executeCanonicalMutationUnit } from "./mutation-unit";
import { requestFor } from "./canonical-request";

const executableAdapter = ({
  operation,
  caller,
}: Readonly<{ operation: string; caller: HostedCanonicalCaller }>): ReturnType<
  typeof canonicalHostedStatementAdapter
> => {
  const adapter = canonicalHostedStatementAdapter(operation);
  const catalog = operationCatalog.byId.get(operation);
  if (
    Option.isNone(adapter) ||
    catalog === undefined ||
    decideOperationAccess(catalog.policy.access, {
      _tag: "HostedAgentSession",
      authorityRoot: "verified-whatsapp",
    })._tag !== "Allowed"
  ) {
    return Option.none();
  }
  if (
    catalog.policy.agentConfirmation === "required" &&
    !Option.contains(caller.authorizedOperation, operation)
  ) {
    return Option.none();
  }
  return adapter;
};

const decodeHeldInput = (operation: string, input: unknown): Option.Option<unknown> => {
  const catalog = operationCatalog.byId.get(operation);
  return catalog === undefined ? Option.none() : Schema.decodeUnknownOption(catalog.input)(input);
};

type HeldBatch = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  caller: HostedCanonicalCaller;
  current: number;
  input: unknown;
  fence: HostedCommitFence;
}>;
const executeHeldBatch = (work: HeldBatch): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (!Option.contains(work.caller.authorizedOperation, atomicBatchOperation)) {
      return transactionUnavailable();
    }
    const batch = Schema.decodeUnknownOption(AtomicBatchAdmission)(work.input);
    if (Option.isNone(batch)) return transactionUnavailable();
    const allowed = batch.value.payload.calls.every((input) => {
      const parsed = Schema.decodeUnknownOption(Schema.Struct({ operation: Schema.String }))(input);
      if (Option.isNone(parsed)) return false;
      const operation = parsed.value.operation;
      const child = operationCatalog.byId.get(operation);
      return (
        child !== undefined &&
        child.atomicBatchEligible &&
        decideOperationAccess(child.policy.access, {
          _tag: "HostedAgentSession",
          authorityRoot: "verified-whatsapp",
        })._tag === "Allowed" &&
        Option.isSome(canonicalHostedStatementAdapter(operation))
      );
    });
    if (!allowed) return transactionUnavailable();
    const inference = yield* Effect.serviceOption(HostedInference);
    return yield* executeHostedCanonicalBatch({
      db: work.db,
      bucket: work.bucket,
      subject: work.caller,
      current: work.current,
      calls: batch.value.payload.calls,
      inference,
      oauthConfirmation: Option.none(),
      hostedFence: work.fence,
    }).pipe(
      Effect.provideService(
        HostedInference,
        Option.getOrElse(inference, () => unreachableHostedInference)
      )
    );
  });

const commitPreparation = ({
  db,
  caller,
  current,
  fence,
  preparation,
  present,
}: Pick<HeldBatch, "db" | "caller" | "current" | "fence"> &
  Readonly<{
    preparation: CanonicalMutationPreparation;
    present: (value: CommittedMutationValue) => Effect.Effect<Response>;
  }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (preparation._tag === "Refused") {
      const disposition = yield* preparation.refusal.record();
      return yield* preparation.refusal.respond(disposition);
    }
    if (preparation._tag !== "Prepared") return transactionUnavailable();
    const committed = yield* executeCanonicalMutationUnit({
      db,
      subject: caller,
      current,
      mutations: [preparation.mutation],
      hostedFence: Option.some(fence),
      oauthConfirmation: Option.none(),
    });
    if (committed._tag !== "Committed") return transactionUnavailable();
    const value = committed.values[0];
    return value === undefined ? transactionUnavailable() : yield* present(value);
  });

const missingInference = (
  operation: string,
  inference: Option.Option<HostedInferenceService>
): boolean => {
  const catalog = operationCatalog.byId.get(operation);
  return (
    catalog === undefined ||
    (canonicalOperationRequiresInference(catalog.id) && Option.isNone(inference))
  );
};

/** Agent's admitted statement call uses the installed catalogue, owner adapter and canonical unit.
 * This private entry accepts no browser credential, PAT, raw bytes, storage coordinate or new tools.
 */
export const executeHostedStatementCall = ({
  db,
  bucket,
  caller,
  current,
  operation,
  input,
  fence,
}: Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  caller: HostedCanonicalCaller;
  current: number;
  operation: string;
  input: unknown;
  fence: HostedCommitFence;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (caller.turnId !== fence.turnId) return transactionUnavailable();
    if (operation === atomicBatchOperation) {
      return yield* executeHeldBatch({ db, bucket, caller, current, input, fence });
    }
    const adapter = executableAdapter({ operation, caller });
    const decoded = decodeHeldInput(operation, input);
    if (Option.isNone(adapter) || Option.isNone(decoded)) return transactionUnavailable();
    const inference = yield* Effect.serviceOption(HostedInference);
    if (missingInference(operation, inference)) return transactionUnavailable();
    const preparation = yield* adapter.value
      .prepare({
        caller,
        db,
        bucket,
        userId: caller.userId,
        authority: caller.authority,
        originSessionId: Option.some(caller.sessionId),
        originTurns: Option.some(caller.originTurns),
        publicationOrigin: Option.some(caller.publicationOrigin),
        requiredScope: Option.none(),
        current,
        input: decoded.value,
      })
      .pipe(
        Effect.provideService(
          HostedInference,
          Option.getOrElse(inference, () => unreachableHostedInference)
        )
      );
    return yield* commitPreparation({
      db,
      caller,
      current,
      fence,
      preparation,
      present: adapter.value.present,
    });
  });

/** Hosted reads use the existing canonical query owner and its shared metadata-only Audit. */
export const executeHostedStatementQuery = ({
  db,
  bucket,
  caller,
  current,
  operation,
  input,
}: Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
  caller: HostedCanonicalCaller;
  current: number;
  operation: string;
  input: unknown;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const declaration = operationCatalog.byId.get(operation);
    if (
      declaration === undefined ||
      decideOperationAccess(declaration.policy.access, {
        _tag: "HostedAgentSession",
        authorityRoot: "verified-whatsapp",
      })._tag !== "Allowed"
    ) {
      return transactionUnavailable();
    }
    const owner = canonicalHostedStatementQueryOwner(operation);
    const decoded = decodeHeldInput(operation, input);
    if (Option.isNone(owner) || Option.isNone(decoded)) return transactionUnavailable();
    const catalog = operationCatalog.byId.get(operation);
    const json = Schema.decodeUnknownOption(Schema.Json)(input);
    const request =
      catalog === undefined || Option.isNone(json)
        ? Option.none()
        : requestFor({ operation: catalog, input: json.value });
    if (Option.isNone(request)) return transactionUnavailable();
    return yield* owner.value({
      caller,
      request: request.value,
      db,
      bucket,
      userId: caller.userId,
      authority: caller.authority,
      originSessionId: Option.some(caller.sessionId),
      originTurns: Option.some(caller.originTurns),
      publicationOrigin: Option.some(caller.publicationOrigin),
      requiredScope: Option.none(),
      current,
      input: decoded.value,
    });
  });
