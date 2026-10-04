import { Effect, Option, Schema } from "effect";
import { operationCatalog } from "../../../src/shell/api";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import { transactionUnavailable } from "../../canonical-work/operations";
import type { HostedCommitFence } from "../../agent/contract";
import { canonicalHostedStatementQueryOwner } from "./query-registry";
import { canonicalHostedStatementAdapter } from "./mutation-registry";
import { executeCanonicalMutationUnit } from "./mutation-unit";

const executableAdapter = ({
  operation,
  caller,
}: Readonly<{ operation: string; caller: HostedCanonicalCaller }>): ReturnType<
  typeof canonicalHostedStatementAdapter
> => {
  const adapter = canonicalHostedStatementAdapter(operation);
  const catalog = operationCatalog.byId.get(operation);
  if (Option.isNone(adapter) || catalog === undefined) return Option.none();
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
    const adapter = executableAdapter({ operation, caller });
    const decoded = decodeHeldInput(operation, input);
    if (Option.isNone(adapter) || Option.isNone(decoded)) return transactionUnavailable();
    const preparation = yield* adapter.value.prepare({
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
    });
    if (committed._tag !== "Committed") return transactionUnavailable();
    const value = committed.values[0];
    return value === undefined ? transactionUnavailable() : yield* adapter.value.present(value);
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
    const owner = canonicalHostedStatementQueryOwner(operation);
    const decoded = decodeHeldInput(operation, input);
    if (Option.isNone(owner) || Option.isNone(decoded)) return transactionUnavailable();
    return yield* owner.value({
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
