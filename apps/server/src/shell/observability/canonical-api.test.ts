import { expect, layer } from "@effect/vitest";
import { Effect, Option } from "effect";
import { HttpClient } from "effect/unstable/http";
import { TransactionId } from "~/core/transactions/model";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarnessClient, ApiTelemetryHarness } from "~/shell/testing/api-harness";
import {
  errorEnvelopePayloads as errorPayloads,
  transactionEnvelopePayloads as transactionPayloads,
} from "~/shell/testing/telemetry-envelope-fixtures";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";
import { EnvelopeRecorder } from "./envelope-recorder";

layer(ApiTelemetryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "canonical API telemetry",
  (it) => {
    it.effect(
      "traces Transaction capture through its repository work without changing the response",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const client = yield* ApiHarnessClient;
          const recorder = yield* EnvelopeRecorder;
          yield* recorder.clear;
          const input = transactionPayload({ counterparty: "telemetry-payload-sentinel" });

          const created = yield* client.transactions.createTransaction({ payload: input });
          const persisted = yield* client.transactions.getTransaction({
            params: { id: created.data.id },
          });
          const envelopes = yield* recorder.serializedEnvelopes;
          const transactions = transactionPayloads(envelopes);
          const captureTrace = transactions.filter(
            (transaction) => transaction.tags.operation === "transactions.createTransaction"
          );
          const root = transactions.find(
            (transaction) =>
              transaction.transaction === "POST /transactions" &&
              transaction.contexts.trace.op === "http.server"
          );
          const operation = captureTrace.find(
            (transaction) => transaction.contexts.trace.op === "fidy.operation"
          );
          const repository = transactions.find(
            (transaction) =>
              transaction.contexts.trace.op === "db" &&
              transaction.contexts.trace.data["fidy.repository_operation"] === "capture_transaction"
          );
          const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

          expect(persisted.data).toEqual(created.data);
          const observedRoot = Option.getOrThrow(Option.fromUndefinedOr(root));
          const observedOperation = Option.getOrThrow(Option.fromUndefinedOr(operation));
          const observedRepository = Option.getOrThrow(Option.fromUndefinedOr(repository));
          expect(observedRoot.contexts.trace.data).toMatchObject({
            "http.request.method": "POST",
            "http.route": "/transactions",
          });
          expect(
            transactions.some(
              (transaction) =>
                transaction.transaction === "GET /transactions/:id" &&
                transaction.contexts.trace.op === "http.server"
            )
          ).toBe(true);
          expect(observedRepository.contexts.trace.data).toMatchObject({
            "db.system.name": "postgresql",
            "fidy.repository_operation": "capture_transaction",
          });
          expect(observedOperation.contexts.trace.trace_id).toBe(
            observedRoot.contexts.trace.trace_id
          );
          expect(observedOperation.contexts.trace.parent_span_id).toBe(
            observedRoot.contexts.trace.span_id
          );
          expect(observedRepository.contexts.trace.trace_id).toBe(
            observedRoot.contexts.trace.trace_id
          );
          expect(observedRepository.contexts.trace.parent_span_id).toBe(
            observedOperation.contexts.trace.span_id
          );
          expect(serialized).not.toContain("telemetry-payload-sentinel");
          expect(serialized).not.toContain(created.data.id);
          expect(serialized).not.toContain("authorization");
          expect(serialized).not.toContain("Bearer");
          expect(serialized).not.toContain("INSERT INTO");
          expect(serialized).not.toContain('"request"');
          expect(serialized).not.toContain('"response"');
          expect(serialized).not.toContain('"user"');
        })
    );

    it.effect(
      "records fixed absence and authorization outcomes without creating error issues",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const client = yield* ApiHarnessClient;
          const recorder = yield* EnvelopeRecorder;
          const absentId = TransactionId.make("f1d1a000-0000-4000-8000-00000000dead");

          yield* recorder.clear;
          yield* Effect.result(client.transactions.getTransaction({ params: { id: absentId } }));
          const absentEnvelopes = yield* recorder.serializedEnvelopes;
          const absentTraces = transactionPayloads(absentEnvelopes);

          yield* recorder.clear;
          const forgedTraceId = "a".repeat(32);
          const unauthorized = yield* HttpClient.get("/transactions", {
            headers: { traceparent: `00-${forgedTraceId}-${"b".repeat(16)}-01` },
          });
          const unauthorizedEnvelopes = yield* recorder.serializedEnvelopes;
          const unauthorizedTraces = transactionPayloads(unauthorizedEnvelopes);

          expect(unauthorized.status).toBe(401);
          expect(absentTraces).toHaveLength(2);
          for (const trace of absentTraces) {
            expect(trace.tags).toMatchObject({ outcome: "rejected", error: "not_found" });
          }
          expect(unauthorizedTraces).toHaveLength(2);
          for (const trace of unauthorizedTraces) {
            expect(trace.tags).toMatchObject({ outcome: "rejected", error: "unauthenticated" });
            expect(trace.contexts.trace.trace_id).not.toBe(forgedTraceId);
          }
          expect(errorPayloads(absentEnvelopes)).toEqual([]);
          expect(errorPayloads(unauthorizedEnvelopes)).toEqual([]);
        })
    );

    it.effect(
      "captures an unexpected persistence defect once at HTTP ownership without its cause text",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const client = yield* ApiHarnessClient;
          const recorder = yield* EnvelopeRecorder;
          const sql = yield* MigrationSqlClient;
          yield* sql`
          CREATE OR REPLACE FUNCTION reject_observed_capture() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'defect-payload-sentinel';
          END;
          $$ LANGUAGE plpgsql
        `;
          yield* sql`DROP TRIGGER IF EXISTS reject_observed_capture ON transactions`;
          yield* sql`
          CREATE TRIGGER reject_observed_capture BEFORE INSERT ON transactions
          FOR EACH ROW EXECUTE FUNCTION reject_observed_capture()
        `;
          const removeFailure = sql`
          DROP TRIGGER IF EXISTS reject_observed_capture ON transactions
        `.pipe(
            Effect.andThen(sql`DROP FUNCTION IF EXISTS reject_observed_capture()`),
            Effect.orDie
          );
          yield* recorder.clear;

          const result = yield* Effect.result(
            client.transactions.createTransaction({ payload: transactionPayload() })
          ).pipe(Effect.ensuring(removeFailure));
          const envelopes = yield* recorder.serializedEnvelopes;
          const errors = errorPayloads(envelopes);
          const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

          expect(result._tag).toBe("Failure");
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            exception: { values: [{ type: "FidyDefect", value: "Unexpected defect" }] },
            fingerprint: ["api", "transactions.createTransaction", "unexpected_defect"],
            tags: {
              component: "api",
              operation: "transactions.createTransaction",
              error: "unexpected_defect",
            },
            contexts: { trace: { op: "http.server" } },
          });
          const frames = errors[0]?.exception.values[0].stacktrace.frames ?? [];
          expect(frames.length).toBeGreaterThan(0);
          expect(typeof frames[0]?.module).toBe("string");
          expect(typeof frames[0]?.filename).toBe("string");
          expect(typeof frames[0]?.function).toBe("string");
          expect(typeof frames[0]?.lineno).toBe("number");
          expect(typeof frames[0]?.colno).toBe("number");
          expect(errors[0]).not.toHaveProperty("breadcrumbs");
          expect(serialized).not.toContain("defect-payload-sentinel");
          expect(serialized).not.toContain('"cause"');
          expect(serialized).not.toContain('"contexts":{"trace":{"data"');
        })
    );
  }
);
