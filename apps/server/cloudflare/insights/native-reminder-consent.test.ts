import { HostedTurnProcessing, HostedTurnProposal } from "../../src/shell/agent/contract";
import { ownerCheckUrl } from "../maintenance/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, category, seed } from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";
import { DisclosureSnapshot, type ProactivityOptInKind } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";

type OfferKind = ProactivityOptInKind | "weekly-summary";

const commands: Record<OfferKind, string> = {
  "weekly-summary": "Activar el resumen semanal",
  "manual-entry-reminder": "Activar recordatorios",
  "budget-threshold": "Activar alertas de presupuesto",
  "new-recurring-series": "Activar avisos de cargos recurrentes",
};

const launchFor = (kind: OfferKind): Readonly<Record<string, string>> =>
  kind === "weekly-summary"
    ? {
        PROACTIVITY_ENABLED: "disabled",
        WEEKLY_SUMMARY_ENABLED: "enabled",
        PROACTIVITY_ASK_AFTER: "1",
        PROACTIVITY_PAUSE_AFTER: "1",
      }
    : {};

const buttonPrefix = (kind: OfferKind): string =>
  kind === "weekly-summary" ? "weekly:" : "p:" + kind + ":";

const foreignButton = (kind: OfferKind, qualified: string): string =>
  kind === "weekly-summary"
    ? qualified.replace("weekly:", "p:manual-entry-reminder:")
    : qualified.replace(kind, "manual-entry-reminder");

const signedReminderJourney = Effect.fnUntraced(function* (
  kind: OfferKind = "manual-entry-reminder"
) {
  const runtime = yield* (yield* nativeHostedPlatform)(undefined, [], launchFor(kind)),
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
        context: reply === "" ? undefined : { id: reply },
      },
    });
  });

  expect((yield* say("wamid.request", commands[kind])).status).toBe(202);

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
    buttonPrefix(kind) + (yield* Schema.decodeUnknownEffect(Schema.String)(claim.operation_id));

  expect((yield* say("wamid.early", qualified + ":accept")).status).toBe(422);
  const providerMessage = "wamid.reminder-disclosure";

  const settle = Effect.fn(function* (message: string, correlation: unknown) {
    return yield* webhook("whatsapp.message.delivered", {
      phone_number_id: endpoint,
      message: {
        id: message,
        kapso: {
          direction: "outbound",
          status: "delivered",
          statuses: [
            {
              id: message,
              status: "delivered",
              timestamp: String(Math.floor((yield* Clock.currentTimeMillis) / 1000)),
              recipient_user_id: bsuid,
              biz_opaque_callback_data: correlation,
            },
          ],
        },
      },
    });
  });

  expect((yield* settle(providerMessage, claim.correlation)).status).toBe(200);
  yield* owner.exec("SELECT 1 FROM whatsapp_deliveries WHERE state='delivered'").pipe(
    Effect.filterOrFail(
      (rows) => rows.length === 1,
      () => "pending"
    ),
    Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
  );
  expect((yield* say("wamid.optin", "Sí", providerMessage)).status).toBe(200);
  expect((yield* say("wamid.optin", "Sí", providerMessage)).status).toBe(200);

  yield* Effect.gen(function* () {
    expect(
      yield* owner.exec(
        "SELECT revision,json_extract(snapshot_json,'$.timing.hour') AS hour FROM reminder_schedules"
      )
    ).toEqual([{ revision: 1, hour: 18 }]);
  }).pipe(Effect.when(Effect.succeed(kind === "manual-entry-reminder")));

  expect(
    yield* owner.exec(
      "SELECT json_extract(record_json,'$.evidence.decisionMessage.providerMessageId') AS message FROM proactive_grants"
    )
  ).toEqual([{ message: "wamid.optin" }]);
  expect(
    yield* owner.exec("SELECT kind FROM proactive_grants WHERE revoked_at_ms IS NULL")
  ).toEqual([{ kind }]);

  yield* Effect.gen(function* () {
    expect(yield* owner.exec("SELECT count(*) n FROM reminder_schedules")).toEqual([{ n: 0 }]);
    expect(yield* owner.exec("SELECT portfolio,bsuid,endpoint FROM reminder_channels")).toEqual([
      { portfolio, bsuid, endpoint },
    ]);
    expect(
      (yield* say("wamid.cross-kind", foreignButton(kind, qualified) + ":revoke")).status
    ).toBe(422);
  }).pipe(Effect.when(Effect.succeed(kind !== "manual-entry-reminder")));

  const deliverBudget = Effect.gen(function* () {
    const current = yield* DateTime.now,
      offset = 12 - DateTime.getPartUtc(current, "hour");

    const zone = offset === 0 ? "Etc/UTC" : "Etc/GMT" + (offset > 0 ? "-" : "+") + Math.abs(offset);
    yield* owner.exec("UPDATE users SET time_zone=?", zone);

    const post = Effect.fn(function* (path: string, body: Schema.Json) {
      return yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com" + path, {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      );
    });

    const cap = { amount: "100", currency: "COP" };
    expect((yield* post("/budgets", { categoryId: category, cap })).status).toBe(201);
    expect(
      (yield* post("/transactions", {
        money: cap,
        direction: "outflow",
        categoryId: category,
        occurredAt: DateTime.formatIso(current),
      })).status
    ).toBe(201);

    const [message] = yield* owner
      .exec(
        "SELECT correlation,operation_id FROM whatsapp_deliveries WHERE family='proactivity' AND started_ms IS NOT NULL"
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for the Budget delivery"
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("60 millis") })
      );

    if (message === undefined) return yield* Effect.die("Missing claimed Budget delivery");
    expect((yield* settle("wamid.thresholds", message.correlation)).status).toBe(200);

    const delivered = yield* owner
      .exec(
        "SELECT json_extract(receipt_json,'$.providerMessageId') AS provider FROM insight_events WHERE json_extract(event_json,'$.kind')='budget-threshold' AND receipt_json IS NOT NULL"
      )
      .pipe(
        Effect.repeat({
          until: (rows) => rows.length === 2,
          times: 100,
          schedule: Schedule.spaced("60 millis"),
        })
      );

    expect(delivered).toEqual([{ provider: "wamid.thresholds" }, { provider: "wamid.thresholds" }]);
    expect(yield* owner.exec("SELECT count(*) n FROM proactive_transcript")).toEqual([{ n: 1 }]);
  });

  const materializeDigest = Effect.gen(function* () {
    const now = yield* DateTime.now,
      offset = 12 - DateTime.getPartUtc(now, "hour"),
      zone = offset === 0 ? "Etc/UTC" : "Etc/GMT" + (offset > 0 ? "-" : "+") + Math.abs(offset);

    const yesterday = DateTime.subtract(now, { days: 1 });
    yield* owner.exec(
      "UPDATE recurring_digest_instructions SET acceptance_from_ms=?,next_ms=0",
      yesterday.epochMilliseconds - 86400000
    );

    const schema =
      "INSERT INTO recurring_series(user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,confirmation_id,confirmed_at_ms,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence) VALUES(?,?,'COP',?,'{}','{}','{}',1,?,?,?, ?,0,?)";

    const context = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: zone,
    });

    const merchants = ["Banco", "Café", "Excluido"];

    yield* Effect.forEach(
      merchants.entries(),
      Effect.fnUntraced(function* ([index, merchant]) {
        const id = "22570000-0000-4000-8000-00000000010" + index,
          series = "22570000-0000-4000-8000-00000000020" + index;

        const snapshot = {
          id,
          seriesId: series,
          money: { amount: "25.15", currency: "COP" },
          counterparty: merchant,
          confirmedAt: DateTime.formatIso(yesterday),
          cadence: { kind: "monthly" },
          announcement:
            index === 2 ? { kind: "suppressed", reason: "backfill" } : { kind: "eligible" },
        };

        yield* owner.exec(
          schema,
          alice.user,
          series,
          merchant,
          id,
          yesterday.epochMilliseconds,
          context,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(snapshot),
          index + 1
        );
      }),
      { discard: true }
    );

    const [projection] = yield* owner.exec(
      "SELECT fact_revision,first_captured_at_ms,time_zone FROM transaction_projection_state WHERE user_id=?",
      alice.user
    );

    if (projection === undefined) return yield* Effect.die("Missing registered ledger");
    yield* owner.exec(
      "INSERT INTO recurring_evaluation_records(kind,id,group_key,user_id,revision,phase,cursor_id,evaluated_revision,evaluated_at_ms,first_captured_at_ms,time_zone) VALUES('progress','progress','',?,?,'complete','',?,?,?,?) ON CONFLICT DO UPDATE SET revision=excluded.revision,phase='complete',evaluated_revision=excluded.evaluated_revision,evaluated_at_ms=excluded.evaluated_at_ms",
      alice.user,
      projection.fact_revision,
      projection.fact_revision,
      now.epochMilliseconds,
      projection.first_captured_at_ms,
      zone
    );
    const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
    yield* native(() => users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));

    const [frozen] = yield* owner
      .exec(
        "SELECT event_id,json_extract(report_json,'$.payload.items') AS items FROM recurring_digest_reports"
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for recurring digest"
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("60 millis") })
      );

    if (frozen === undefined) return yield* Effect.die("Missing frozen digest report");

    const items = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.Struct({ counterparty: Schema.String })))
    )(frozen.items);

    expect(items.map((item) => item.counterparty)).toEqual(["Banco", "Café"]);

    const [claim] = yield* owner
      .exec(
        "SELECT correlation FROM whatsapp_deliveries WHERE family='proactivity' AND started_ms IS NOT NULL AND operation_id=?",
        frozen.event_id
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for digest delivery"
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("60 millis") })
      );

    if (claim === undefined) return yield* Effect.die("Missing digest claim");
    expect((yield* settle("wamid.recurring-digest", claim.correlation)).status).toBe(200);

    const receipts = yield* owner
      .exec(
        "SELECT id FROM insight_events WHERE receipt_json IS NOT NULL AND json_extract(receipt_json,'$.providerMessageId')='wamid.recurring-digest'"
      )
      .pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          times: 100,
          schedule: Schedule.spaced("60 millis"),
        })
      );

    expect(receipts).toEqual([{ id: frozen.event_id }]);
  });

  const deliverWeekly = Effect.gen(function* () {
    expect(
      yield* owner.exec(
        "SELECT revision,json_extract(snapshot_json,'$.timing.weekday') AS weekday FROM weekly_schedules"
      )
    ).toEqual([{ revision: 1, weekday: 0 }]);
    const now = yield* DateTime.now;
    const offset = 12 - DateTime.getPartUtc(now, "hour");
    const zone = offset === 0 ? "Etc/UTC" : "Etc/GMT" + (offset > 0 ? "-" : "+") + Math.abs(offset);
    const local = DateTime.setZoneNamedUnsafe(now, zone);
    const before = DateTime.subtract(now, { minutes: 2 });
    const timing = DateTime.setZoneNamedUnsafe(before, zone);
    yield* owner.exec(
      "UPDATE weekly_schedules SET next_ms=?,snapshot_json=json_set(snapshot_json,'$.timeZone',?,'$.timing.weekday',?,'$.timing.hour',?,'$.timing.minute',?,'$.nextScheduledAt',?)",
      before.epochMilliseconds,
      zone,
      DateTime.getPart(local, "weekDay"),
      DateTime.getPart(timing, "hour"),
      DateTime.getPart(timing, "minute"),
      DateTime.formatIso(before)
    );

    const insert =
      "INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) VALUES(?,?,?,?,'outflow',?,?,?)";

    yield* owner.exec(
      insert,
      alice.session,
      alice.user,
      "9007199254740993.15",
      "USD",
      category,
      before.epochMilliseconds - 86400000,
      owner.now
    );
    yield* owner.exec(
      insert,
      alice.user,
      alice.user,
      "53",
      "COP",
      category,
      before.epochMilliseconds - 86400000,
      owner.now
    );
    const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
    expect(
      (yield* native(() => users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" })))
        .status
    ).toBe(204);

    const [work] = yield* owner
      .exec(
        "SELECT w.correlation,w.operation_id,r.presentation FROM whatsapp_deliveries w JOIN weekly_summary_reports r ON r.id=w.operation_id WHERE w.family='proactivity' AND w.started_ms IS NOT NULL"
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "weekly summary not delivered"
        ),
        Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })
      );

    if (work === undefined) return yield* Effect.die("missing weekly report");

    const presentation = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ currencies: Schema.Array(Schema.String) }))
    )(work.presentation);

    expect(presentation.currencies).toEqual(["COP", "USD"]);
    expect((yield* settle("wamid.weekly-summary", work.correlation)).status).toBe(200);

    const receipt = yield* owner
      .exec(
        "SELECT json_extract(receipt_json,'$.providerMessageId') AS provider FROM insight_events WHERE id=? AND receipt_json IS NOT NULL",
        work.operation_id
      )
      .pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          times: 100,
          schedule: Schedule.spaced("50 millis"),
        })
      );

    expect(receipt).toEqual([{ provider: "wamid.weekly-summary" }]);

    const [question] = yield* owner
      .exec(
        "SELECT a.unanswered,a.question_delivered_ms,w.correlation FROM weekly_attention a JOIN whatsapp_deliveries w ON w.operation_id=a.question_id AND w.started_ms IS NOT NULL"
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for governor question"
        ),
        Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
      );

    if (question === undefined) return yield* Effect.die("Missing question");
    expect(question.unanswered).toBe(1);
    expect(question.question_delivered_ms).toBeNull();
    expect((yield* settle("wamid.weekly-governor-question", question.correlation)).status).toBe(
      200
    );

    const seen = yield* owner
      .exec("SELECT 1 AS yes FROM weekly_attention WHERE question_delivered_ms IS NOT NULL")
      .pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          times: 80,
          schedule: Schedule.spaced("50 millis"),
        })
      );

    expect(seen).toEqual([{ yes: 1 }]);
    yield* Effect.sleep("1100 millis");

    const after = DateTime.subtract(now, { minutes: 1 }),
      later = DateTime.setZoneNamedUnsafe(after, zone);

    yield* owner.exec(
      "UPDATE weekly_schedules SET next_ms=?,snapshot_json=json_set(snapshot_json,'$.timing.hour',?,'$.timing.minute',?,'$.nextScheduledAt',?)",
      after.epochMilliseconds,
      DateTime.getPart(later, "hour"),
      DateTime.getPart(later, "minute"),
      DateTime.formatIso(after)
    );
    yield* native(() => users.getByName(alice.user).fetch(ownerCheckUrl, { method: "POST" }));

    const [last] = yield* owner
      .exec(
        "SELECT correlation FROM whatsapp_deliveries WHERE family='proactivity' AND started_ms IS NOT NULL AND operation_id<>?",
        work.operation_id
      )
      .pipe(
        Effect.filterOrFail(
          (rows) => rows.length === 1,
          () => "waiting for second occurrence"
        ),
        Effect.retry({ times: 80, schedule: Schedule.spaced("50 millis") })
      );

    if (last === undefined) return yield* Effect.die("Missing second occurrence");
    expect((yield* settle("wamid.weekly-second", last.correlation)).status).toBe(200);
    expect(
      yield* owner.exec("SELECT unanswered FROM weekly_attention WHERE paused_ms IS NOT NULL").pipe(
        Effect.repeat({
          until: (rows) => rows.length === 1,
          times: 80,
          schedule: Schedule.spaced("50 millis"),
        })
      )
    ).toEqual([{ unanswered: 2 }]);

    const provider = (yield* native(() =>
      runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
    )).getByName("provider");

    expect(
      yield* native(() =>
        provider.fetch("https://fixture.invalid/templates").then((reply) => reply.json())
      )
    ).toEqual([
      "fidy_weekly_question",
      "fidy_weekly_summary",
      "fidy_weekly_question",
      "fidy_weekly_summary",
    ]);

    const browserTurn = Effect.fn(function* (path: string, body: unknown) {
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(body);

      return yield* native(() =>
        runtime.dispatchFetch("https://api.fidyapp.com/web/hosted-turns" + path, {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "__Host-fidy_session=" + alice.bearer,
            "Fidy-Session-Binding": alice.session,
            "content-type": "application/json",
          },
          body: encoded,
        })
      );
    });

    const accepted = yield* browserTurn("", { text: "¿Por qué dejaron de llegar los resúmenes?" });

    const { turnId } = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
      yield* native(() => accepted.json())
    );

    yield* native(() => provider.fetch("https://fixture.invalid/release"));

    const notice = yield* Effect.retry(
      Effect.gen(function* () {
        const response = yield* browserTurn("/progress", { turnId });

        return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
          yield* native(() => response.json())
        );
      }),
      { times: 80, schedule: Schedule.spaced("50 millis") }
    );

    expect(notice.text).toContain("Pausé tus resúmenes semanales");
    expect(yield* owner.exec("SELECT notice_delivered FROM weekly_attention")).toEqual([
      { notice_delivered: 0 },
    ]);
    expect((yield* browserTurn("/delivery", { turnId, receipt: notice.receipt })).status).toBe(200);
    expect(yield* owner.exec("SELECT notice_delivered FROM weekly_attention")).toEqual([
      { notice_delivered: 1 },
    ]);
  });

  yield* {
    "new-recurring-series": materializeDigest,
    "budget-threshold": deliverBudget,
    "manual-entry-reminder": Effect.void,
    "weekly-summary": deliverWeekly,
  }[kind];
  expect((yield* say("wamid.revoke", qualified + ":revoke")).status).toBe(200);
  expect(
    yield* owner.exec("SELECT count(*) AS active FROM proactive_grants WHERE revoked_at_ms IS NULL")
  ).toEqual([{ active: 0 }]);
  expect(yield* owner.exec("SELECT count(*) AS turns FROM hosted_turns")).toEqual([
    { turns: kind === "weekly-summary" ? 1 : 0 },
  ]);

  if (kind !== "manual-entry-reminder") return;
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
    "requests and decides the original signed weekly question through the approved template and actual workflow with category delivery disabled",
    () => signedReminderJourney("weekly-summary")
  );
  test.effect(
    "activates a Reminder only from a signed explicit reply to the delivered original disclosure and revokes the same grant",
    () => signedReminderJourney()
  );
  test.effect.each(["budget-threshold", "new-recurring-series"] as const)(
    "requires the delivered opt-in for %s and refuses a different grant kind",
    (kind) => signedReminderJourney(kind)
  );
});
