import { type ConfirmationRead, describeConfirmation } from "./confirmation-description";
import { meterHistory } from "./local-history";
import { stageChallenge } from "./local-challenge";
import type {
  LocalMutationPreparation,
  LocalMutationResult,
  LocalReviewFacts,
} from "../../canonical-admission/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Schema } from "effect";
import {
  AgentIteration,
  CanonicalToolEvidence,
  type CanonicalToolOutcome,
  ToolCallId,
  type TranscriptEntry,
} from "../../../src/core/agent/contract";
import type {
  HostedContinuationEvent,
  HostedTextToolCall,
} from "../../../src/shell/hosted-inference/contract";
import type { ConsentSubject } from "../../../src/shell/consent/contract";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  localHostedCatalog,
  prepareHostedBatchOwner,
  prepareHostedOwner,
} from "../../canonical-operations/operations";
import { admitLocalRequest, commitLocalWrite } from "../../canonical-admission/operations";
import { type LocalTurn, channelAuthority } from "./local-turn";
import { appendEntry, entryIdentity, liveTurn } from "./local-turn-store";
import { AgentUnavailable } from "../contract";

type Action = { turn: LocalTurn; iteration: number; storage: DurableObjectStorage } & Partial<{
  confirmed: LocalReviewFacts;
  commercial: { origin: string; offers: Option.Option<Schema.Json> };
}>;

const Outcome = Data.taggedEnum<CanonicalToolOutcome>();

const Entry = Data.taggedEnum<TranscriptEntry>();

const Continuation = Data.taggedEnum<HostedContinuationEvent>();

const Subject = Data.taggedEnum<ConsentSubject>();

const failure = (code: string): CanonicalToolOutcome =>
  Outcome.CanonicalOperationFailed({ failure: { error: { code } } });

const firstFailureStatus = 400;

const currentConsent = Effect.fn(function* (turn: LocalTurn) {
  const sql = yield* SqliteClient;

  const guard = protectConsentStatement({
    subject: Subject.User({ userId: turn.user_id }),
    requirement: "active",
    statement: { sql: "SELECT 1 FROM users WHERE id=?", params: [turn.user_id] },
  });

  const [live] = yield* sql.unsafe(guard.sql, guard.params);

  return live !== undefined;
});

const grantsTier = Effect.fn(function* (turn: LocalTurn, now: number, tier: string) {
  if (tier === "free") return true;
  const sql = yield* SqliteClient;
  const access = activeProUserCondition({ userId: turn.user_id, nowEpochMs: now });

  return (yield* sql.unsafe("SELECT 1 WHERE " + access.sql, access.params)).length === 1;
});

const decodedOutcome = Effect.fn(function* (
  result: LocalMutationResult,
  operation: CatalogOperation
) {
  if (result.status >= firstFailureStatus) {
    return Outcome.CanonicalOperationFailed({ failure: result.body });
  }

  yield* Schema.decodeEffect(operation.success)(result.body);

  return Outcome.Succeeded({ output: result.body });
});

const approve = Effect.fn(function* (
  plan: LocalMutationPreparation,
  tool: HostedTextToolCall,
  { action, required }: { action: Action; required: boolean }
) {
  if (!required) return true;

  if (!("commit" in plan)) return tool.operation === "operations.executeAtomicBatch";

  if (Option.isNone(plan.review)) return false;
  const fresh = yield* plan.review.value;

  if (action.confirmed !== undefined) {
    return action.confirmed.effect === fresh.effect && action.confirmed.revision === fresh.revision;
  }

  yield* stageChallenge(action.turn, tool, fresh);

  return false;
});

const channelContext = (
  turn: LocalTurn
): { accountability: { turnId: string; sessionId: string } } & Partial<{ hostedTurn: string }> => {
  const accountability = { turnId: turn.id, sessionId: turn.session_id };

  return Option.match(turn.browser_id, {
    onNone: () => ({ accountability, hostedTurn: turn.id }),
    onSome: () => ({ accountability }),
  });
};

const describeBatchChild = Effect.fnUntraced(function* (
  turn: LocalTurn,
  storage: DurableObjectStorage,
  current: number
) {
  const user = yield* liveTurn(turn, current);
  const allowed = localHostedCatalog(channelAuthority(turn));

  const read: ConfirmationRead = (id, args) =>
    Effect.gen(function* () {
      const query = allowed.find((op) => op.id === id && op.policy.kind === "query");

      if (query === undefined) return Option.none<Schema.Json>();

      const prepared = yield* prepareHostedOwner(query, args, {
        user: turn.user_id,
        storage,
        current,
        ...channelContext(turn),
      });

      if (Option.isNone(prepared)) return Option.none<Schema.Json>();
      const result = yield* commitLocalWrite(prepared.value);

      return result.outcome === "success" ? Option.some(result.body) : Option.none();
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning({
          component: "agent",
          operation: "describeBatchChild",
          outcome: "undescribed",
        })
      ),
      Effect.orElseSucceed(() => Option.none())
    );

  return (
    operation: string,
    input: Schema.Json
  ): Effect.Effect<Option.Option<string>, never, SqliteClient> =>
    describeConfirmation({ context: { timeZone: user.timeZone, read }, operation, input });
});

const ownerForTool = Effect.fnUntraced(function* (
  operation: CatalogOperation,
  input: CanonicalToolEvidence,
  { tool, action, now }: { tool: HostedTextToolCall; action: Action; now: number }
) {
  const { turn } = action;

  const base = {
    user: turn.user_id,
    current: now,
    storage: action.storage,
    ...channelContext(turn),
  };

  const context =
    action.commercial === undefined ? base : { ...base, commercial: action.commercial };

  return operation.id === "operations.executeAtomicBatch"
    ? Option.some(
        yield* prepareHostedBatchOwner(input, {
          ...context,
          turnId: turn.id,
          toolCallId: tool.id,
          describe: yield* describeBatchChild(turn, action.storage, now),
          authorityRoot: channelAuthority(turn),
        })
      )
    : yield* prepareHostedOwner(operation, input, context);
});

const executeOwner = Effect.fn(function* (
  tool: HostedTextToolCall,
  input: CanonicalToolEvidence,
  action: Action
) {
  const { turn } = action,
    now = yield* Clock.currentTimeMillis;

  yield* liveTurn(turn, now);

  if (!(yield* currentConsent(turn))) return failure("consent_required");

  const operation = localHostedCatalog(channelAuthority(turn)).find(
    ({ id }) => id === tool.operation
  );

  if (operation === undefined) return failure("scope_missing");

  if (Option.isNone(Schema.decodeOption(operation.input, { onExcessProperty: "error" })(input))) {
    return failure("validation_failed");
  }

  if (!(yield* grantsTier(turn, now, operation.policy.requiredTier))) {
    return failure("paywall_required");
  }

  if ((yield* admitLocalRequest({ user: turn.user_id, current: now })).length !== 1) {
    return failure("rate_limited");
  }

  const plan = yield* ownerForTool(operation, input, { tool, action, now });

  if (Option.isNone(plan)) return failure("unavailable");

  if (
    !(yield* approve(plan.value, tool, {
      action,
      required: operation.policy.agentConfirmation === "required",
    }))
  ) {
    return failure("user_action_required");
  }

  const result = yield* commitLocalWrite(plan.value);

  return yield* decodedOutcome(result, operation);
});

export const applyTool = Effect.fn(function* (tool: HostedTextToolCall, action: Action) {
  const { turn } = action,
    sql = yield* SqliteClient;

  const current = yield* Clock.currentTimeMillis;
  yield* liveTurn(turn, current);
  const toolCallId = yield* Schema.decodeEffect(ToolCallId)(tool.id);
  const input = yield* Schema.decodeUnknownEffect(CanonicalToolEvidence)(tool.params);
  const iteration = AgentIteration.make(action.iteration);

  const [existing] =
    yield* sql`SELECT 1 FROM hosted_tool_calls WHERE turn_id=${turn.id} AND tool_call_id=${toolCallId}`;

  if (existing !== undefined) return yield* new AgentUnavailable();
  const common = { iteration, toolCallId, operation: tool.operation };
  yield* appendEntry(
    turn.session_id,
    Entry.CanonicalToolCallEntry({ ...entryIdentity(turn.id)(current), ...common, input })
  );
  const resultIdentity = entryIdentity(turn.id)(current);

  const outcome = yield* meterHistory(
    turn,
    Entry.CanonicalToolResultEntry({
      ...resultIdentity,
      ...common,
      outcome: yield* executeOwner(tool, input, action),
    })
  );

  yield* sql`INSERT INTO hosted_tool_calls VALUES(${turn.id},${toolCallId},${tool.operation},${outcome._tag},${current})`;
  yield* appendEntry(
    turn.session_id,
    Entry.CanonicalToolResultEntry({ ...resultIdentity, ...common, outcome })
  );

  return Continuation.ToolResult({ toolCallId, operation: tool.operation, outcome });
});
