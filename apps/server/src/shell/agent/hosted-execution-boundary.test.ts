import assert from "node:assert/strict";
import { expect, layer } from "@effect/vitest";
import { Cause, DateTime, Effect, Exit, Layer, Result, Stream } from "effect";
import type { Schema } from "effect";
import { allCanonicalCapabilities } from "~/core/_shared/canonical-capability";
import { UserId } from "~/core/identity/reference";
import { makeColombianUser } from "~/core/identity/rules";
import { HostedAgentSessionId } from "~/core/transcript/hosted-agent-session";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import {
  CanonicalCallRejected,
  executeHostedCanonicalOperation,
} from "~/shell/_shared/canonical-operation-executor";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import { upsertUser } from "~/shell/identity/repo";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness } from "~/shell/testing/api-harness";
import { MigrationSqlClient } from "~/shell/db/client";
import type { ConfirmationPermit } from "./tool-confirmation-model";
import { immediatePermit } from "./tool-confirmation";
import { agentOperationBindings, makeAgentToolkit } from "./toolkit";

const boundaryUserId = UserId.make("f1d1a000-0000-4000-8000-0000000009a1");
const boundarySessionId = HostedAgentSessionId.make("f1d1a000-0000-4000-8000-0000000009a2");

const BoundaryHarness = ApiHarness.pipe(Layer.provideMerge(TelemetryDisabled));

const hostedCaller: CanonicalCaller = {
  subjectUserId: boundaryUserId,
  capabilities: allCanonicalCapabilities,
  auditCaller: { _tag: "HostedAgentSession", hostedAgentSessionId: boundarySessionId },
  authorityRoot: "verified-whatsapp",
};

const bindingFor = (operation: string): (typeof agentOperationBindings)[number] => {
  const binding = agentOperationBindings.find((candidate) => candidate.operation === operation);
  if (binding === undefined) throw new Error(`Canonical operation is missing: ${operation}`);
  return binding;
};

/**
 * A real permit for exactly this call, so a refusal can never be attributed to a stubbed one. The
 * runtime issues the same permit for any operation that needs no confirmation.
 */
const permitFor = (operation: string, input: Schema.Json): ConfirmationPermit =>
  immediatePermit({ binding: bindingFor(operation), input });

/**
 * A real permit that closes the workflow as it is spent. Decorating the genuine permit keeps its
 * exact binding-and-input matching in play while the test drives the one interleaving it needs.
 */
const permitClosingWorkflow = (
  operation: string,
  input: Schema.Json,
  close: () => void
): ConfirmationPermit => {
  const permit = permitFor(operation, input);
  return {
    consume: (attempt) => Effect.tap(permit.consume(attempt), () => Effect.sync(close)),
  };
};

const prepareBoundaryUser = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`DELETE FROM audit_log_entries WHERE user_id = ${boundaryUserId}`;
  yield* sql`DELETE FROM memories WHERE user_id = ${boundaryUserId}`;
  yield* upsertUser(
    boundaryUserId,
    yield* makeColombianUser(boundaryUserId, {
      createdAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
      paidTier: "free",
    })
  );
});

const committedMemoryCount = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* sql`SELECT count(*)::int AS count FROM memories WHERE user_id = ${boundaryUserId}`;
});

const auditOutcomes = Effect.map(observeAuditLogEntries(boundaryUserId), (entries) =>
  entries.map((entry) => `${entry.operation}:${entry.outcome}`)
);

// The boundary's failure channel is the erased implementation's `object`, so a test narrows it to
// the declared rejection rather than asserting on a shape it cannot see.
const refusalReason = <A, R>(
  call: Effect.Effect<A, object, R>
): Effect.Effect<CanonicalCallRejected["reason"], never, R> =>
  Effect.map(Effect.result(call), (outcome) => {
    assert.ok(Result.isFailure(outcome), "the boundary must refuse this call");
    assert.ok(outcome.failure instanceof CanonicalCallRejected);
    return outcome.failure.reason;
  });

/**
 * The rejection a refused dispatch dies with. A refusal the declared failure schema cannot carry
 * back to the model leaves the handler as a defect, so the test checks the die and its reason
 * rather than settling for "something failed".
 */
const dispatchRejection = (exit: Exit.Exit<unknown, unknown>): CanonicalCallRejected => {
  assert.ok(Exit.isFailure(exit), "the dispatch must be refused");
  const defect = Cause.findDefect(exit.cause);
  assert.ok(Result.isSuccess(defect), "a refused dispatch dies with its rejection");
  assert.ok(defect.success instanceof CanonicalCallRejected);
  return defect.success;
};

layer(BoundaryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "hosted execution boundary",
  (it) => {
    it.effect("refuses a call whose hosted workflow already closed and records the refusal", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;

        const reason = yield* refusalReason(
          executeHostedCanonicalOperation({
            caller: hostedCaller,
            binding: bindingFor("memory.recall"),
            untrustedInput: {},
            confirmationPermit: permitFor("memory.recall", {}),
            isExecutionActive: () => false,
          })
        );

        expect(reason).toBe("authority_closed");
        expect(yield* auditOutcomes).toEqual(["memory.recall:rejected"]);
      })
    );

    it.effect("refuses a call whose permit declines it and records the refusal", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;

        const reason = yield* refusalReason(
          executeHostedCanonicalOperation({
            caller: hostedCaller,
            binding: bindingFor("memory.recall"),
            untrustedInput: {},
            // A permit issued for a different input is what the real matching rejects.
            confirmationPermit: permitFor("memory.recall", { query: "otra consulta" }),
            isExecutionActive: () => true,
          })
        );

        expect(reason).toBe("confirmation_rejected");
        expect(yield* auditOutcomes).toEqual(["memory.recall:rejected"]);
      })
    );

    it.effect("refuses a call whose input the canonical schema rejects", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;

        const reason = yield* refusalReason(
          executeHostedCanonicalOperation({
            caller: hostedCaller,
            binding: bindingFor("memory.recall"),
            untrustedInput: { query: 17 },
            confirmationPermit: permitFor("memory.recall", {}),
            isExecutionActive: () => true,
          })
        );

        expect(reason).toBe("input_rejected");
        expect(yield* auditOutcomes).toEqual(["memory.recall:rejected"]);
      })
    );

    it.effect("commits nothing when the hosted workflow closes after its permit is spent", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;
        let executionActive = true;

        const reason = yield* refusalReason(
          executeHostedCanonicalOperation({
            caller: hostedCaller,
            binding: bindingFor("memory.remember"),
            untrustedInput: { payload: { text: "el arriendo se paga el primer dia del mes" } },
            // Closing while the permit is spent is the recheck the canonical transaction makes
            // before it runs the operation.
            confirmationPermit: permitClosingWorkflow(
              "memory.remember",
              { payload: { text: "el arriendo se paga el primer dia del mes" } },
              () => {
                executionActive = false;
              }
            ),
            isExecutionActive: () => executionActive,
          })
        );

        expect(reason).toBe("authority_closed");
        expect(yield* committedMemoryCount).toEqual([{ count: 0 }]);
        expect(yield* auditOutcomes).toEqual(["memory.remember:rejected"]);
      })
    );

    // The only case where a real handler outlives the workflow that built it. The flag is owned by
    // the workflow and cleared by `ensuring` on return, exactly as the hosted runtime owns it, so
    // what the refusal is measured against is a genuine lifetime rather than a supplied predicate.
    it.effect("refuses a retained tool handler once its workflow has returned", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;
        const binding = bindingFor("memory.remember");
        const input = { payload: { text: "el arriendo se paga el primer dia del mes" } };
        let executionActive = true;

        const escaped = yield* Effect.gen(function* () {
          const toolkit = yield* makeAgentToolkit({
            caller: hostedCaller,
            isExecutionActive: () => executionActive,
          });
          yield* toolkit.prepare(binding, input, permitFor("memory.remember", input));
          return (): Effect.Effect<void, object, never> =>
            toolkit.handle(binding.wireName, input).pipe(Stream.unwrap, Stream.runDrain);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              executionActive = false;
            })
          )
        );

        const exit = yield* Effect.exit(escaped());

        expect(dispatchRejection(exit).reason).toBe("authority_closed");
        expect(yield* committedMemoryCount).toEqual([{ count: 0 }]);
        expect(yield* auditOutcomes).toEqual(["memory.remember:rejected"]);
      })
    );

    it.effect("records evidence for a hosted call that no prepared permit covers", () =>
      Effect.gen(function* () {
        yield* prepareBoundaryUser;
        const toolkit = yield* makeAgentToolkit({
          caller: hostedCaller,
          isExecutionActive: () => true,
        });
        const binding = bindingFor("memory.recall");

        // Dispatching without a prepared permit is the correlation defense firing, so it must leave
        // evidence like every other refusal on this boundary.
        const exit = yield* Effect.exit(
          toolkit.handle(binding.wireName, {}).pipe(Stream.unwrap, Stream.runDrain)
        );

        expect(dispatchRejection(exit).reason).toBe("confirmation_rejected");
        expect(yield* auditOutcomes).toEqual(["memory.recall:rejected"]);
      })
    );
  }
);
