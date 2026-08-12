import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MemoryText, RememberInput } from "~/core/memory/model";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { defaultUserId } from "~/shell/db/development-seed";
import { EnvelopeRecorder } from "~/shell/observability/envelope-recorder";
import { defaultAgentBearer } from "~/shell/testing/identity-fixtures";
import {
  ApiHarness,
  ApiHarnessClient,
  ApiTelemetryHarness,
  headersFor,
} from "~/shell/testing/api-harness";
import { truncateMemories } from "./fixtures";

const encodeRemember = Schema.encodeSync(RememberInput);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })("Memory API", (it) => {
  it.effect("normalizes, persists, and recalls every current Memory in stable order", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const raw = yield* HttpClient.post("/memories", {
        headers: headersFor(defaultAgentBearer),
        body: HttpBody.jsonUnsafe({ text: "  primera\r\nmemoria  " }),
      });
      expect(raw.status).toBe(201);
      const client = yield* ApiHarnessClient;
      const second = yield* client.memory.remember({
        payload: { text: MemoryText.make("segunda memoria") },
      });
      const recalled = yield* client.memory.recall();
      const rawRecall = yield* HttpClient.get("/memories", {
        headers: headersFor(defaultAgentBearer),
      });

      expect(rawRecall.headers["cache-control"]).toBe("no-store");
      expect(recalled.data.map(({ text }) => text)).toEqual([
        "primera\nmemoria",
        "segunda memoria",
      ]);
      expect(recalled.data[1]).toEqual(second.data);
      expect(recalled.next).toEqual([]);
    })
  );

  it.effect(
    "serializes concurrent remember calls so aggregate capacity cannot be oversubscribed",
    () =>
      Effect.gen(function* () {
        yield* truncateMemories;
        const client = yield* ApiHarnessClient;
        for (let index = 0; index < 6; index += 1) {
          yield* client.memory.remember({
            payload: { text: MemoryText.make(`${index}${"x".repeat(1_999)}`) },
          });
        }
        const outcomes = yield* Effect.all(
          ["a", "b"].map((prefix) =>
            client.memory.remember({
              payload: { text: MemoryText.make(`${prefix}${"z".repeat(1_999)}`) },
            })
          ),
          { concurrency: "unbounded", mode: "result" }
        );
        const recalled = yield* client.memory.recall();

        expect(outcomes.map(({ _tag }) => _tag).toSorted()).toEqual(["Failure", "Success"]);
        expect(recalled.data).toHaveLength(7);
      })
  );

  it.effect("rejects aggregate overflow without dropping existing Memories or echoing prose", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      yield* truncateAuditLogEntries;
      const client = yield* ApiHarnessClient;
      for (let index = 0; index < 7; index += 1) {
        yield* client.memory.remember({
          payload: { text: MemoryText.make(`${index}${"x".repeat(1_999)}`) },
        });
      }
      const canary = `private-capacity-canary-${"y".repeat(1_976)}`;
      const response = yield* HttpClient.post("/memories", {
        headers: headersFor(defaultAgentBearer),
        body: HttpBody.jsonUnsafe(encodeRemember({ text: MemoryText.make(canary) })),
      });
      const body = yield* response.text;
      const recalled = yield* client.memory.recall();
      const audit = yield* observeAuditLogEntries(defaultUserId);

      expect(response.status).toBe(409);
      expect(body).toContain("quota_exhausted");
      expect(body).not.toContain("private-capacity-canary");
      expect(recalled.data).toHaveLength(7);
      expect(recalled.data.some(({ text }) => text.includes("private-capacity-canary"))).toBe(
        false
      );
      expect(audit.map((entry) => Object.keys(entry).toSorted())).toEqual(
        audit.map(() => ["id", "occurredAt", "operation", "outcome", "subjectUserId", "tokenId"])
      );
      expect(audit.map(({ operation }) => operation)).toContain("memory.remember");
    })
  );
});

layer(ApiTelemetryHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "Memory API privacy telemetry",
  (it) => {
    it.effect("keeps accepted and rejected Memory prose out of telemetry", () =>
      Effect.gen(function* () {
        yield* truncateMemories;
        const client = yield* ApiHarnessClient;
        const recorder = yield* EnvelopeRecorder;
        yield* recorder.clear;
        const acceptedCanary = `accepted-memory-canary-${"x".repeat(1_976)}`;
        yield* client.memory.remember({ payload: { text: MemoryText.make(acceptedCanary) } });
        for (let index = 0; index < 6; index += 1) {
          yield* client.memory.remember({
            payload: { text: MemoryText.make(`${index}${"y".repeat(1_999)}`) },
          });
        }
        const rejectedCanary = `rejected-memory-canary-${"z".repeat(1_976)}`;
        yield* Effect.result(
          client.memory.remember({ payload: { text: MemoryText.make(rejectedCanary) } })
        );
        const serialized = (yield* recorder.serializedEnvelopes)
          .map((bytes) => new TextDecoder().decode(bytes))
          .join("\n");

        expect(serialized).not.toContain("accepted-memory-canary");
        expect(serialized).not.toContain("rejected-memory-canary");
      })
    );
  }
);
