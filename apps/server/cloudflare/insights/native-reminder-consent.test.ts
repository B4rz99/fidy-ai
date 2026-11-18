import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, seed } from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";

const signedReminderJourney = Effect.fnUntraced(function* () {
  const runtime = yield* (yield* nativeHostedPlatform)(),
    owner = yield* seed(runtime, alice);
  const portfolio = "123456789012345",
    bsuid = "CO.13491208655302741918",
    endpoint = "8444555566667";
  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=? WHERE id=?",
    portfolio,
    bsuid,
    owner.now,
    alice.user
  );
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
    alice.user,
    alice.user,
    owner.now,
    yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor())
  );
  yield* native(() =>
    owner.directory.exec(
      "INSERT INTO whatsapp_routes(portfolio,bsuid,user_id,attempt_id,established) VALUES(?,?,?,?,1)",
      portfolio,
      bsuid,
      alice.user,
      "native-offer"
    )
  );
  const webhook = Effect.fnUntraced(function* (event: string, payload: unknown) {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload);
    const signature = new Bun.CryptoHasher("sha256", "callback-fixture-secret")
      .update(body)
      .digest("hex");
    return yield* native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/providers/kapso/callback", {
        method: "POST",
        headers: {
          "x-webhook-event": event,
          "x-webhook-signature": signature,
          "x-idempotency-key": "native-reminder-" + event,
        },
        body,
      })
    );
  });
  const say = Effect.fnUntraced(function* (id: string, text: string, reply: string = "") {
    return yield* webhook("whatsapp.message.received", {
      phone_number_id: endpoint,
      conversation: { business_scoped_user_id: bsuid },
      message: {
        id,
        timestamp: String(Math.floor((yield* Clock.currentTimeMillis) / 1000)),
        from_user_id: bsuid,
        type: "text",
        text: { body: text },
        ...(reply === "" ? {} : { context: { id: reply } }),
      },
    });
  });
  expect((yield* say("wamid.request", "Activar recordatorios")).status).toBe(202);
  const [claim] = yield* owner
    .exec(
      "SELECT correlation,operation_id FROM whatsapp_deliveries WHERE family='disclosure' AND started_ms IS NOT NULL"
    )
    .pipe(
      Effect.filterOrFail(
        (rows) => rows.length === 1,
        () => "waiting"
      ),
      Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
    );
  if (claim === undefined) return yield* Effect.die("missing disclosure claim");
  const qualified =
    "p:manual-entry-reminder:" +
    (yield* Schema.decodeUnknownEffect(Schema.String)(claim.operation_id));
  expect((yield* say("wamid.early", qualified + ":accept")).status).toBe(422);
  const providerMessage = "wamid.reminder-disclosure";
  expect(
    (yield* webhook("whatsapp.message.delivered", {
      phone_number_id: endpoint,
      message: {
        id: providerMessage,
        kapso: {
          direction: "outbound",
          status: "delivered",
          statuses: [
            {
              id: providerMessage,
              status: "delivered",
              timestamp: String(Math.floor((yield* Clock.currentTimeMillis) / 1000)),
              recipient_user_id: bsuid,
              biz_opaque_callback_data: claim.correlation,
            },
          ],
        },
      },
    })).status
  ).toBe(200);
  yield* owner.exec("SELECT 1 FROM whatsapp_deliveries WHERE state='delivered'").pipe(
    Effect.filterOrFail(
      (rows) => rows.length === 1,
      () => "pending"
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
  );
  expect((yield* say("wamid.optin", "Sí", providerMessage)).status).toBe(200);
  expect((yield* say("wamid.optin", "Sí", providerMessage)).status).toBe(200);
  expect(
    yield* owner.exec(
      "SELECT revision,json_extract(snapshot_json,'$.timing.hour') AS hour FROM reminder_schedules"
    )
  ).toEqual([{ revision: 1, hour: 18 }]);
  expect(
    yield* owner.exec(
      "SELECT json_extract(record_json,'$.evidence.decisionMessage.providerMessageId') AS message FROM proactive_grants"
    )
  ).toEqual([{ message: "wamid.optin" }]);
  expect((yield* say("wamid.revoke", qualified + ":revoke")).status).toBe(200);
  expect(
    yield* owner.exec("SELECT count(*) AS active FROM proactive_grants WHERE revoked_at_ms IS NULL")
  ).toEqual([{ active: 0 }]);
  expect(yield* owner.exec("SELECT count(*) AS turns FROM hosted_turns")).toEqual([{ turns: 0 }]);
  const chat = yield* say("wamid.chat", "¿Qué recuerdas?");
  expect(chat.status).toBe(202);
  const controls = yield* native(() =>
    runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  );
  yield* native(() => controls.getByName("provider").fetch("https://fixture.invalid/release"));
  const [sent] = yield* owner
    .exec(
      "SELECT correlation,original_deadline_ms FROM whatsapp_deliveries WHERE family='hosted' AND state='ambiguous'"
    )
    .pipe(
      Effect.filterOrFail(
        (rows) => rows.length === 1,
        () => "still working"
      ),
      Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
    );
  if (sent === undefined) return yield* Effect.die("missing hosted reply");
  expect(
    yield* owner.exec(
      "SELECT count(*) AS n FROM hosted_transcript WHERE json_extract(entry_json,'$._tag')='AssistantTranscriptEntry'"
    )
  ).toEqual([{ n: 0 }]);
  const answer = "wamid.proved-hosted";
  const proof = {
    phone_number_id: endpoint,
    message: {
      id: answer,
      kapso: {
        direction: "outbound",
        status: "delivered",
        statuses: [
          {
            id: answer,
            status: "delivered",
            timestamp: String(Math.floor((yield* Clock.currentTimeMillis) / 1000)),
            recipient_user_id: bsuid,
            biz_opaque_callback_data: sent.correlation,
          },
        ],
      },
    },
  };
  expect((yield* webhook("whatsapp.message.delivered", proof)).status).toBe(200);
  expect((yield* webhook("whatsapp.message.delivered", proof)).status).toBe(200);
  yield* owner.exec("SELECT id FROM hosted_turns WHERE state='completed'").pipe(
    Effect.filterOrFail(
      (rows) => rows.length === 1,
      () => "awaiting delivery"
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
  );
  expect(
    yield* owner.exec(
      "SELECT count(*) AS n FROM hosted_transcript WHERE json_extract(entry_json,'$._tag')='AssistantTranscriptEntry'"
    )
  ).toEqual([{ n: 1 }]);
});
it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "activates a Reminder only from a signed explicit reply to the delivered original disclosure and revokes the same grant",
    signedReminderJourney
  );
});
