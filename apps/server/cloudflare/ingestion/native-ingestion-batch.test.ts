import { it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, Schema } from "effect";
import { expect } from "vitest";
import { alice, nativeTransactionJourney } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";
import { batchCallId } from "./statement-batch.test-fixture";

type CreationCall = Readonly<{
  callId: string;
  operation: "transactions.createTransaction";
  input: Readonly<{
    payload: Readonly<{
      direction: "outflow";
      money: Readonly<{ amount: string; currency: string }>;
      occurredAt: string;
      notes: string;
    }>;
  }>;
}>;

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "registers forwarding before batch disclosure and rejects oversized children, envelopes and browser publication without partial effects",
    () =>
      Effect.gen(function* () {
        const journey = yield* nativeTransactionJourney;
        const now = yield* Clock.currentTimeMillis;
        yield* native(() =>
          journey.exec(
            "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
            alice.user,
            now
          )
        );

        const api = (path: string, data: unknown): Effect.Effect<Response> =>
          native(() =>
            journey.send(
              new Request("https://api.fidyapp.com" + path, {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  cookie: "__Host-fidy_session=" + alice.bearer,
                  "Fidy-Session-Binding": alice.session,
                  "content-type": "application/json",
                },
                body: JSON.stringify(data),
              })
            )
          );

        const batch = (calls: unknown[]): Effect.Effect<Response> =>
          api("/operations/atomic-batch", { calls });

        const enable = {
          callId: batchCallId(1),
          operation: "ingestion.enableEmailForwarding",
          input: {},
        };

        const registered = yield* batch([enable]);
        expect(registered.status).toBe(200);

        const result = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            data: Schema.Struct({
              results: Schema.Array(
                Schema.Struct({
                  operation: Schema.Literal("ingestion.enableEmailForwarding"),
                  output: Schema.Struct({ data: Schema.Struct({ address: Schema.String }) }),
                })
              ),
            }),
          })
        )(yield* native(() => registered.json()));

        expect(result.data.results.map((item) => item.output.data.address)).toHaveLength(1);
        expect(result.data.results[0]?.output.data.address).toMatch(/@fidyapp\.com$/u);

        const call = (suffix: number, notes: string): CreationCall => ({
          callId: batchCallId(suffix),
          operation: "transactions.createTransaction",
          input: {
            payload: {
              direction: "outflow",
              money: { amount: "1", currency: "COP" },
              occurredAt: "2025-01-01T00:00:00.000Z",
              notes,
            },
          },
        });

        const childFailure = yield* batch([call(1, "x".repeat(5000)), call(2, "small")]);
        expect(childFailure.status).toBe(400);
        expect(yield* native(() => childFailure.json())).toMatchObject({
          error: {
            failedCallIndex: 0,
            operation: "transactions.createTransaction",
            code: "validation_failed",
            message:
              "This child's input exceeds the size an individual call of this operation accepts.",
          },
        });

        const oversized = Array.from({ length: 12 }, (_, index) =>
          call(index + 1, "x".repeat(3900))
        );

        const envelopeFailure = yield* batch(oversized);
        expect(envelopeFailure.status).toBe(400);
        expect(yield* native(() => envelopeFailure.json())).toMatchObject({
          error: { code: "validation_failed", message: "Invalid atomic batch input." },
        });

        const payload = {
          idempotencyKey: batchCallId(2),
          reference: { stagingId: batchCallId(3), sha256: "a".repeat(64), byteLength: 32 },
        };

        expect((yield* api("/ingestion/statements/bytes", payload)).status).toBe(403);
        expect((yield* api("/ingestion/statements", payload)).status).toBe(403);
        expect(
          (yield* batch([
            call(1, "small"),
            {
              callId: batchCallId(2),
              operation: "ingestion.submitForExtraction",
              input: { payload },
            },
          ])).status
        ).toBe(400);
        expect(yield* native(() => journey.exec("SELECT count(*) AS n FROM transactions"))).toEqual(
          [{ n: 0 }]
        );
        expect((yield* batch([call(1, "small")])).status).toBe(200);
      })
  );
});
