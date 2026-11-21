import { statusDeliveryUrl } from "../whatsapp/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Data, DateTime, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, seed } from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { ownerCheckUrl } from "../maintenance/contract";
import type { WhatsAppLifecycleWork } from "../whatsapp/contract";

const LifecycleWire = Data.taggedEnum<typeof WhatsAppLifecycleWork.Encoded>();

const testReminder = Effect.fn(function* (beforeClaim: boolean, attention: boolean = false) {
  const create = yield* nativeHostedPlatform,
    runtime = yield* create();

  const owner = yield* seed(runtime, alice);
  const current = yield* DateTime.now;
  const zone = DateTime.formatIso(current).slice(11, 13);
  const offset = 12 - Number(zone);

  const timeZone =
    offset === 0 ? "Etc/UTC" : "Etc/GMT" + (offset > 0 ? "-" : "+") + String(Math.abs(offset));

  const schedule = "22460000-0000-4000-8000-000000000001",
    grant = "22460000-0000-4000-8000-000000000002";

  const minute = DateTime.getPartUtc(current, "minute"),
    due = DateTime.startOf(current, "minute");

  const snapshot = {
    id: schedule,
    version: 1,
    enabled: true,
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone,
    cadence: { kind: "daily" },
    timing: { hour: 12, minute },
    nextScheduledAt: DateTime.formatIso(due),
  };

  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',?)",
    schedule,
    alice.user,
    owner.now
  );
  yield* owner.exec(
    "UPDATE users SET whatsapp_portfolio_id='123456789012345',whatsapp_bsuid='CO.13491208655302741918',whatsapp_verified_at_ms=? WHERE id=?",
    owner.now,
    alice.user
  );
  yield* owner.exec(
    "INSERT INTO proactive_grants(user_id,kind,id,record_json) VALUES(?,'manual-entry-reminder',?,'{}')",
    alice.user,
    grant
  );
  yield* owner.exec(
    "INSERT INTO reminder_schedules(user_id,id,revision,snapshot_json,next_at_ms,grant_id) VALUES(?,?,1,?,?,?)",
    alice.user,
    schedule,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot),
    due.epochMilliseconds,
    grant
  );
  yield* owner.exec(
    "INSERT INTO reminder_channels(grant_id,portfolio,bsuid,endpoint) VALUES(?,'123456789012345','CO.13491208655302741918','8444555566667')",
    grant
  );
  const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const check = Effect.fnUntraced(function* () {
    return yield* native(() =>
      users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" })
    );
  });

  if (beforeClaim) {
    yield* owner.exec(
      "CREATE TRIGGER withdraw_at_reserve AFTER INSERT ON whatsapp_deliveries BEGIN UPDATE proactive_grants SET revoked_at_ms=1 WHERE user_id=NEW.user_id; END"
    );
  }

  if (attention) {
    yield* owner.exec(
      "INSERT INTO reminder_attention(grant_id,unanswered,last_reply_ms) VALUES(?,2,0)",
      grant
    );
  }

  const checked = yield* check();
  expect(checked.status).toBe(204);

  const message = yield* Effect.retry(
    Effect.gen(function* () {
      const [row] = yield* owner.exec(
        "SELECT operation_id,correlation,original_deadline_ms,state FROM whatsapp_deliveries WHERE user_id=? AND family='proactivity'",
        alice.user
      );

      return yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          operation_id: Schema.String,
          correlation: Schema.String,
          original_deadline_ms: Schema.Int,
          state: Schema.Literal(beforeClaim ? "staged" : "ambiguous"),
        })
      )(row);
    }),
    { times: 80, schedule: Schedule.spaced("75 millis") }
  );

  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const body = {
      userId: alice.user,
      operationId: message.operation_id,
      family: "proactivity",
      evidence: LifecycleWire.WhatsAppLifecycleEvent({
        portfolio: "123456789012345",
        recipientUserId: "CO.13491208655302741918",
        correlationToken: message.correlation,
        businessPhoneNumberId: "8444555566667",
        providerMessageId: "wamid.third-reminder",
        outcome: "delivered",
        occurredAtMs: now,
        receivedAtMs: now,
      }),
    };

    const proof = Effect.fnUntraced(function* () {
      return yield* native(() =>
        users
          .getByName(alice.user)
          .fetch(statusDeliveryUrl, { method: "POST", body: JSON.stringify(body) })
      );
    });

    expect((yield* proof()).status).toBe(204);
    expect((yield* proof()).status).toBe(204);
    expect(
      yield* owner.exec(
        "SELECT unanswered,question_id IS NOT NULL AS asked FROM reminder_attention"
      )
    ).toEqual([{ unanswered: 3, asked: 1 }]);
    expect(yield* owner.exec("SELECT count(*) AS n FROM reminder_disclosures")).toEqual([{ n: 1 }]);
    expect(yield* owner.exec("SELECT count(*) AS n FROM proactive_transcript")).toEqual([{ n: 1 }]);
  }).pipe(Effect.when(Effect.succeed(attention)));

  if (attention) return;

  yield* owner.exec(
    "UPDATE proactive_grants SET revoked_at_ms=? WHERE id=?",
    current.epochMilliseconds,
    grant
  );
  yield* check();

  const replay = yield* native(() =>
    users.getByName(alice.user).fetch("https://coordinator/proactivity-work", {
      method: "POST",
      body: JSON.stringify({
        kind: "proactivity-delivery",
        version: 1,
        owner: "user",
        userId: alice.user,
        id: message.operation_id,
      }),
    })
  );

  expect(replay.status).toBe(200);

  const controls = yield* native(() =>
    runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  );

  const report = yield* native(() =>
    controls.getByName("provider").fetch("https://fixture.invalid/sends")
  );

  expect(yield* native(() => report.json())).toMatchObject({
    sends: Number(!beforeClaim),
    correlation: beforeClaim ? "" : message.correlation,
  });
  expect(message.original_deadline_ms).toBe(due.epochMilliseconds + 86400000);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "counts a verified Reminder only once and asks after three unanswered deliveries",
    () => testReminder(false, true)
  );
  test.effect(
    "revokes Reminder Consent after target reservation and before the irreversible provider claim",
    () => testReminder(true)
  );
  test.effect(
    "reaches the approved sender through owner alarm, Queue and Workflow, and reconciles an uncertain reply without resending after revocation",
    () => testReminder(false)
  );
});
