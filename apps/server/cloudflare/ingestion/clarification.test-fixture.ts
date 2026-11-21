import type { Miniflare } from "miniflare";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { type seed } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

const portfolio = "123456789012345";

const recipient = "CO.13491208655302741918";

const secondMs = 1000,
  accepted = 202,
  ok = 200;

const timestamp = Effect.map(Clock.currentTimeMillis, (ms) => String(Math.floor(ms / secondMs)));

const signedWebhook = (
  runtime: Miniflare
): ((
  event: string,
  id: string,
  message: unknown
) => Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>) =>
  Effect.fnUntraced(function* (event: string, id: string, message: unknown) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      phone_number_id: portfolio,
      conversation: { business_scoped_user_id: recipient },
      message,
    }).pipe(Effect.orDie);

    const signature = new Bun.CryptoHasher("sha256", "callback-fixture-secret")
      .update(body)
      .digest("hex");

    return yield* native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/providers/kapso/callback", {
        method: "POST",
        headers: {
          "x-webhook-event": event,
          "x-webhook-signature": signature,
          "x-idempotency-key": id,
        },
        body,
      })
    );
  });

const waitForEvidence = (
  owner: Effect.Success<ReturnType<typeof seed>>
): ((sql: string) => Effect.Effect<{ value: string }, string | Schema.SchemaError>) =>
  Effect.fnUntraced(function* (sql: string) {
    const [row] = yield* owner.exec(sql).pipe(
      Effect.filterOrFail(
        (rows) => rows.length === 1,
        () => "Missing evidence for " + sql
      ),
      Effect.retry({ times: 120, schedule: Schedule.spaced("50 millis") })
    );

    return yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }))(row);
  });

const checkCompleted = Effect.fnUntraced(function* (
  owner: Effect.Success<ReturnType<typeof seed>>,
  batched: boolean
) {
  expect(
    yield* owner.exec(
      "SELECT outcome FROM hosted_tool_calls WHERE operation=? ORDER BY occurred_ms",
      batched ? "operations.executeAtomicBatch" : "ingestion.skipNeedsReviewItem"
    )
  ).toEqual([{ outcome: "CanonicalOperationFailed" }, { outcome: "Succeeded" }]);

  yield* Effect.gen(function* () {
    expect(
      yield* owner.exec("SELECT operation,outcome FROM hosted_batch_child_audit ORDER BY position")
    ).toEqual([
      { operation: "ingestion.skipNeedsReviewItem", outcome: "success" },
      { operation: "dashboard.initializeDashboard", outcome: "success" },
    ]);
  }).pipe(Effect.when(Effect.succeed(batched)));
});

export const completeHostedClarification = Effect.fnUntraced(function* (
  runtime: Miniflare,
  owner: Effect.Success<ReturnType<typeof seed>>,
  { item, batched }: { item: string; batched: boolean }
) {
  const webhook = signedWebhook(runtime);

  const say = Effect.fnUntraced(function* (id: string, text: string) {
    const received = yield* webhook("whatsapp.message.received", id, {
      id,
      timestamp: yield* timestamp,
      from_user_id: recipient,
      type: "text",
      text: { body: text },
    });

    expect(received.status).toBe(accepted);
  });

  const observe = waitForEvidence(owner);

  const delivered = Effect.fnUntraced(function* (id: string) {
    const held = yield* observe(
      "SELECT correlation AS value FROM whatsapp_deliveries WHERE family='hosted' AND state='ambiguous'"
    );

    const result = yield* webhook("whatsapp.message.delivered", id, {
      id,
      kapso: {
        direction: "outbound",
        status: "delivered",
        statuses: [
          {
            id,
            status: "delivered",
            timestamp: yield* timestamp,
            recipient_user_id: recipient,
            biz_opaque_callback_data: held.value,
          },
        ],
      },
    });

    expect(result.status).toBe(ok);
    yield* observe(
      "SELECT 'completed' AS value WHERE NOT EXISTS(SELECT 1 FROM hosted_turns WHERE state='proposed')"
    );
  });

  yield* delivered("wamid.document-ready");
  yield* say(
    "wamid.statement-skip",
    (batched ? "Confirma el lote fila-prueba " : "Omite la fila-prueba ") + item
  );
  const challenge = yield* observe("SELECT command AS value FROM hosted_confirmations");
  expect(
    yield* owner.exec("SELECT workspace_state FROM ingestion_review_items WHERE id=?", item)
  ).toEqual([{ workspace_state: null }]);
  yield* delivered("wamid.review-received");
  yield* say("wamid.statement-confirmation", challenge.value);
  yield* observe(
    "SELECT 'skipped' AS value FROM ingestion_review_items WHERE workspace_state='skipped'"
  );
  yield* checkCompleted(owner, batched);
});
