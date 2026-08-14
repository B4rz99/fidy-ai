import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MemoryText, RememberInput } from "~/core/memory/model";
import { truncateAuditLogEntries } from "~/shell/audit/fixtures";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { defaultUserId } from "~/shell/db/development-seed";
import { EnvelopeRecorder } from "~/shell/observability/envelope-recorder";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import {
  ApiHarness,
  ApiHarnessClient,
  ApiTelemetryHarness,
  headersFor,
} from "~/shell/testing/api-harness";
import { observeMemoryExists, observeMemoryRevision, truncateMemories } from "./fixtures";

const encodeRemember = Schema.encodeSync(RememberInput);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })("Memory API", (it) => {
  it.effect("normalizes, persists, and recalls every current Memory in stable order", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const raw = yield* HttpClient.post("/memories", {
        headers: headersFor(defaultPatBearer),
        body: HttpBody.jsonUnsafe({ text: "  primera\r\nmemoria  " }),
      });
      expect(raw.status).toBe(201);
      const client = yield* ApiHarnessClient;
      const second = yield* client.memory.remember({
        payload: { text: MemoryText.make("segunda memoria") },
      });
      const recalled = yield* client.memory.recall();
      const rawRecall = yield* HttpClient.get("/memories", {
        headers: headersFor(defaultPatBearer),
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

  it.effect("revises one Memory in place through the canonical API", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const client = yield* ApiHarnessClient;
      const first = yield* client.memory.remember({
        payload: { text: MemoryText.make("texto anterior") },
      });
      const second = yield* client.memory.remember({
        payload: { text: MemoryText.make("memoria posterior") },
      });

      const revised = yield* client.memory.revise({
        params: { id: first.data.id },
        payload: { text: MemoryText.make("texto reemplazado") },
      });
      const recalled = yield* client.memory.recall();

      expect(revised.data).toMatchObject({
        id: first.data.id,
        text: "texto reemplazado",
        createdAt: first.data.createdAt,
      });
      expect(recalled.data.map(({ id, text }) => ({ id, text }))).toEqual([
        { id: first.data.id, text: "texto reemplazado" },
        { id: second.data.id, text: "memoria posterior" },
      ]);
    })
  );

  it.effect("physically forgets a Memory and advances every committed mutation revision", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const client = yield* ApiHarnessClient;
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(0n);

      const created = yield* client.memory.remember({
        payload: { text: MemoryText.make("memoria mutable") },
      });
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(1n);

      yield* client.memory.revise({
        params: { id: created.data.id },
        payload: { text: MemoryText.make("memoria revisada") },
      });
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(2n);

      const forgotten = yield* client.memory.forget({ params: { id: created.data.id } });
      expect(forgotten.data).toBe(created.data.id);
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(3n);
      expect((yield* client.memory.recall()).data).toEqual([]);
      expect(yield* observeMemoryExists({ userId: defaultUserId, id: created.data.id })).toBe(
        false
      );
    })
  );

  it.effect("rejects malformed mutation inputs without changing Memory state", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const client = yield* ApiHarnessClient;
      const target = yield* client.memory.remember({
        payload: { text: MemoryText.make("estado intacto") },
      });
      const beforeRevision = yield* observeMemoryRevision(defaultUserId);
      const malformedId = "not-a-memory-id";

      const malformedRevise = yield* HttpClient.put(`/memories/${malformedId}`, {
        headers: headersFor(defaultPatBearer),
        body: HttpBody.jsonUnsafe({ text: "texto nuevo" }),
      });
      const oversizedRevise = yield* HttpClient.put(`/memories/${target.data.id}`, {
        headers: headersFor(defaultPatBearer),
        body: HttpBody.jsonUnsafe({ text: "x".repeat(2_001) }),
      });
      const malformedForget = yield* HttpClient.del(`/memories/${malformedId}`, {
        headers: headersFor(defaultPatBearer),
      });

      expect(malformedRevise.status).toBe(400);
      expect(oversizedRevise.status).toBe(400);
      expect(malformedForget.status).toBe(400);
      expect((yield* client.memory.recall()).data).toEqual([target.data]);
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(beforeRevision);
      expect(yield* observeMemoryExists({ userId: defaultUserId, id: target.data.id })).toBe(true);
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

  it.effect("rejects replacement overflow without changing text or advancing revision", () =>
    Effect.gen(function* () {
      yield* truncateMemories;
      const client = yield* ApiHarnessClient;
      const target = yield* client.memory.remember({
        payload: { text: MemoryText.make("pequeña") },
      });
      for (let index = 0; index < 7; index += 1) {
        yield* client.memory.remember({
          payload: { text: MemoryText.make(`${index}${"x".repeat(1_999)}`) },
        });
      }
      const beforeRevision = yield* observeMemoryRevision(defaultUserId);
      const canary = `rejected-revision-canary-${"z".repeat(1_974)}`;

      const rejected = yield* Effect.result(
        client.memory.revise({
          params: { id: target.data.id },
          payload: { text: MemoryText.make(canary) },
        })
      );
      const recalled = yield* client.memory.recall();

      expect(rejected).toMatchObject({
        _tag: "Failure",
        failure: { error: { code: "quota_exhausted" } },
      });
      expect(recalled.data[0]).toEqual(target.data);
      expect(recalled.data.some(({ text }) => text.includes("rejected-revision-canary"))).toBe(
        false
      );
      expect(yield* observeMemoryRevision(defaultUserId)).toBe(beforeRevision);
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
        headers: headersFor(defaultPatBearer),
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
        const target = (yield* client.memory.recall()).data[0];
        if (target === undefined) return yield* Effect.die("Expected a retained Memory");
        const callerControlledId = "f1d1a000-0000-4000-8000-00000000cafe";
        yield* Effect.result(
          HttpClient.put(`/memories/${callerControlledId}`, {
            headers: headersFor(defaultPatBearer),
            body: HttpBody.jsonUnsafe({ text: "rejected-revise-canary" }),
          })
        );
        yield* Effect.result(
          client.memory.revise({
            params: { id: target.id },
            payload: { text: MemoryText.make("accepted-revise-canary") },
          })
        );
        yield* Effect.result(client.memory.forget({ params: { id: target.id } }));
        const serialized = (yield* recorder.serializedEnvelopes)
          .map((bytes) => new TextDecoder().decode(bytes))
          .join("\n");

        expect(serialized).not.toContain("accepted-memory-canary");
        expect(serialized).not.toContain("rejected-memory-canary");
        expect(serialized).not.toContain("rejected-revise-canary");
        expect(serialized).not.toContain("accepted-revise-canary");
        expect(serialized).not.toContain(callerControlledId);
      })
    );
  }
);
