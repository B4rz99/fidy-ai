import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Array as Arr, Clock, DateTime, Effect, Option, Result, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, history, seed } from "../financial-user-store.test-fixture";
import { native, nativeHealthPlatform } from "../user-store.test-fixture";
import { maintenanceName } from "./contract";

const cases = [
  { label: "category only", weekly: false, category: true, missing: "neither" },
  { label: "weekly only", weekly: true, category: false, missing: "neither" },
  { label: "weekly and category", weekly: true, category: true, missing: "neither" },
  { label: "both disabled", weekly: false, category: false, missing: "both" },
  { label: "missing Queue", weekly: false, category: true, missing: "queue" },
  { label: "missing Workflow", weekly: false, category: true, missing: "workflow" },
  { label: "stalled canary", weekly: false, category: false, missing: "stall" },
] as const;

const counters = "https://fixture.invalid/monitoring-counters";

const delivery = "90000000-0000-4000-8000-000000000012",
  question = "90000000-0000-4000-8000-000000000013";

type Scenario = (typeof cases)[number];

const expectedObservations = (scenario: Scenario): string[] =>
  Arr.getSomes([
    scenario.category && scenario.missing !== "workflow"
      ? Option.some("proactivity-" + alice.user + "-" + delivery)
      : Option.none(),
    scenario.weekly
      ? Option.some("weekly-" + alice.user + "-weekly-question-" + question)
      : Option.none(),
  ]);

const queueMetrics = (scenario: Scenario): number =>
  (scenario.weekly || scenario.category) && scenario.missing !== "queue" ? 1 : 0;

type Features = Readonly<{
  ASYNC_HEALTH_ENABLED: "enabled";
  WEEKLY_SUMMARY_ENABLED: "enabled" | "disabled";
  PROACTIVITY_ENABLED: "enabled" | "disabled";
  MONITOR_FIXTURE: Scenario["missing"];
}>;

const features = (scenario: Scenario): Features => ({
  ASYNC_HEALTH_ENABLED: "enabled",
  WEEKLY_SUMMARY_ENABLED: scenario.weekly ? "enabled" : "disabled",
  PROACTIVITY_ENABLED: scenario.category ? "enabled" : "disabled",
  MONITOR_FIXTURE: scenario.missing,
});

const testCase = Effect.fn(function* (scenario: Scenario) {
  const create = yield* nativeHealthPlatform,
    logs: string[] = [];

  const runtime = yield* create(undefined, logs, features(scenario));

  const owner = yield* seed(runtime, alice),
    other = yield* seed(runtime, bob),
    now = yield* Clock.currentTimeMillis;

  yield* Effect.forEach(
    [
      [owner, alice],
      [other, bob],
    ] as const,
    Effect.fnUntraced(function* ([store, who]) {
      yield* store.exec(
        "INSERT INTO proactive_grants VALUES(?,'budget-threshold',?,'{}',NULL)",
        who.user,
        who.user
      );
      yield* store.exec(
        "INSERT INTO insight_events VALUES(?,?,?,1,?,?,NULL)",
        who.user,
        delivery,
        who.session,
        now - 600000,
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          id: delivery,
          scheduleId: who.session,
          scheduleVersion: 1,
          kind: "budget-threshold",
        })
      );
      yield* store.exec(
        "INSERT INTO reminder_deliveries(id,user_id,grant_id,correlation,portfolio,bsuid,endpoint,deadline_ms,offer_ms,body,digest,created_ms) VALUES(?,?,?,?,'portfolio','private-contact','phone',?,?,'private-report','opaque',?)",
        delivery,
        who.user,
        who.user,
        delivery,
        now + 3600000,
        now + 600000,
        now - 600000
      );
      yield* store.exec(
        "INSERT INTO reminder_disclosures(id,user_id,portfolio,bsuid,endpoint,request_message,created_ms,expires_ms,attempt_ms,correlation,disclosure,body,digest,kind) VALUES(?,?,'portfolio','private-contact','phone','source',?,?,?,?,'{}','private-question','opaque','weekly-summary')",
        question,
        who.user,
        now - 300000,
        now + 3600000,
        now + 600000,
        question
      );
    }),
    { discard: true }
  );

  yield* Effect.forEach(
    [alice, bob],
    Effect.fnUntraced(function* (who) {
      const registered = yield* history(runtime, who);
      expect(registered.status).toBe(200);
      yield* native(() => registered.arrayBuffer());
    }),
    { discard: true }
  );

  const core = yield* native(() => runtime.getWorker("core"));
  const scheduled = Math.floor(now / 3600000) * 3600000 + 5000;

  const registry = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
  );

  yield* native(() =>
    registry.exec(
      "INSERT INTO user_recovery VALUES(?,?,?,1),(?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET due_ms=excluded.due_ms",
      alice.user,
      alice.user,
      scheduled,
      bob.user,
      bob.user,
      scheduled
    )
  );

  const ran = yield* Effect.tryPromise(() =>
    core.scheduled({
      cron: "* * * * *",
      scheduledTime: DateTime.toDate(DateTime.makeUnsafe(scheduled)),
    })
  ).pipe(Effect.result);

  const shouldFail = ["stall", "queue", "workflow"].includes(scenario.missing);
  expect(Result.isSuccess(ran) && ran.success.outcome === "ok").toBe(!shouldFail);
  const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
  const expectedIds = expectedObservations(scenario);

  const inspected = yield* native(() =>
    users
      .getByName(alice.user)
      .fetch(counters)
      .then((reply) => reply.json())
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
    Effect.repeat({
      until: (rows) => rows.length === expectedIds.length,
      times: 80,
      schedule: Schedule.spaced("30 millis"),
    })
  );

  expect(inspected).toEqual(expectedIds);
  expect(
    yield* native(() =>
      users
        .getByName(bob.user)
        .fetch(counters)
        .then((reply) => reply.json())
    )
  ).toEqual([]);
  const counts = yield* native(() => core.fetch(counters).then((reply) => reply.json()));
  expect(counts).toEqual({
    canary: 1,
    metrics: queueMetrics(scenario),
  });

  const progress = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Maintenance", { name: maintenanceName })
  );

  expect(
    yield* native(() => progress.exec("SELECT scheduled,attempted,observed FROM watchdog_progress"))
  ).toEqual([{ scheduled, attempted: 5, observed: 5 }]);
  const enabled = scenario.weekly || scenario.category;

  if (enabled) {
    yield* Effect.sync(() =>
      logs.some((log) => log.includes("operation=proactivity state=attention"))
    ).pipe(Effect.repeat({ until: Boolean, times: 100, schedule: Schedule.spaced("30 millis") }));
  }

  const exported = logs.join("\n");
  expect(exported.includes("operation=proactivity state=attention")).toBe(enabled);
  expect(exported.includes("operation=proactivityQueue state=")).toBe(enabled);
  expect(exported).toContain(
    "operation=requiredBindings state=" +
      (["queue", "workflow"].includes(scenario.missing) ? "unavailable" : "healthy")
  );

  for (const secret of [
    alice.user,
    bob.user,
    delivery,
    question,
    "private-report",
    "private-contact",
  ]) {
    expect(exported).not.toContain(secret);
  }
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) =>
  test.effect.each(cases)(
    "samples only enabled work with $label and preserves unrelated watchdog progress",
    testCase
  )
);
