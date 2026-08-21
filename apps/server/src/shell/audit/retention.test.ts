import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { CanonicalOperationId } from "~/core/audit/model";
import { defaultUserId } from "~/shell/db/development-seed";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import { ProjectedTransaction } from "~/shell/observability/projectors";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { decodeEnvelopeItems } from "~/shell/testing/telemetry-fixtures";
import { truncateAuditLogEntries } from "./fixtures";
import { appendAuditLogEntry, observeAuditLogEntries } from "./repo";
import { runScheduledAuditRetention } from "./retention";

const AuditRetentionHarness = Layer.merge(ApiHarness, TelemetryEnvelopeRecording);

const scheduledTransactions = (
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<ProjectedTransaction> =>
  envelopes
    .flatMap(decodeEnvelopeItems)
    .flatMap((item) => Option.toArray(Schema.decodeUnknownOption(ProjectedTransaction)(item)))
    .filter((transaction) => transaction.transaction === "task.auditRetention");

layer(AuditRetentionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "AuditLogEntry retention",
  (it) => {
    it.effect("removes only evidence older than the 365-day cutoff", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;
        yield* client.identity.getCurrentUser();
        const [attributed] = yield* observeAuditLogEntries(defaultUserId);
        if (attributed === undefined) return yield* Effect.die("missing attributable token");

        yield* truncateAuditLogEntries;
        const now = DateTime.makeUnsafe("2026-07-01T12:00:00Z");
        const cutoff = DateTime.makeUnsafe("2025-07-01T12:00:00Z");
        const entries = [
          { operation: "identity.getCurrentUser", occurredAt: "2025-07-01T11:59:59Z" },
          { operation: "transactions.listTransactions", occurredAt: "2025-07-01T12:00:00Z" },
          { operation: "identity.updateUserPreferences", occurredAt: "2025-07-01T12:00:01Z" },
        ] as const;

        yield* Effect.forEach(entries, (entry) =>
          appendAuditLogEntry(defaultUserId, {
            caller: attributed.caller,
            operation: CanonicalOperationId.make(entry.operation),
            outcome: "succeeded",
            occurredAt: DateTime.makeUnsafe(entry.occurredAt),
          })
        );

        const recorder = yield* EnvelopeRecorder;
        yield* runScheduledAuditRetention(now);
        yield* runScheduledAuditRetention(now);

        const retained = yield* observeAuditLogEntries(defaultUserId);
        expect(retained.map((entry) => entry.occurredAt)).toEqual([
          cutoff,
          DateTime.makeUnsafe("2025-07-01T12:00:01Z"),
        ]);
        const executions = scheduledTransactions(yield* recorder.serializedEnvelopes);
        expect(executions).toHaveLength(2);
        expect(new Set(executions.map(({ contexts }) => contexts.trace.trace_id)).size).toBe(2);
        expect(
          executions.every(({ contexts }) => contexts.trace.parent_span_id === undefined)
        ).toBe(true);
      })
    );
  }
);
