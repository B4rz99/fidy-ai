import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { native } from "../user-store.test-fixture";
import { journey } from "./turn-journey.test-fixture";

const dayMs = 86400000;

const compactionJourney = Effect.fn(function* () {
  const { db, post, provider, user, start, proposal, now } = yield* journey();
  const midnight = (Math.floor(now / dayMs) + 1) * dayMs;

  const providerCalls = (mode?: string): Effect.Effect<{ readonly calls: number }> =>
    native(() =>
      provider
        .fetch(
          "https://fixture.invalid/compaction",
          mode === undefined ? {} : { method: "POST", body: mode }
        )
        .then((response) => response.json())
        .then(Schema.decodeUnknownSync(Schema.Struct({ calls: Schema.Int })))
    );

  const owner = (path: string): Effect.Effect<Pick<Response, "status">> =>
    native(() => user.fetch("https://fixture.invalid/" + path));

  const clock = Effect.fn(function* (instant: number) {
    yield* owner("set-opportunity-clock?now=" + instant);
  });

  yield* owner("hold-alarm");
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  yield* native(() => db.exec("UPDATE web_sessions SET idle_expires_at_ms=?", midnight + 3600000));

  const deliver = Effect.fn(function* (turnId: string) {
    const visible = yield* proposal(turnId);
    expect((yield* post("/delivery", { turnId, receipt: visible.receipt })).status).toBe(200);
  });

  const run = Effect.fn(function* (instant: number) {
    const id = yield* start();
    expect((yield* owner("clocked-alarm?now=" + instant)).status).toBe(204);
    yield* deliver(id);

    return id;
  });

  const seed = Effect.fn(function* (id: string) {
    yield* native(() =>
      db.exec(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<80) INSERT INTO hosted_transcript(session_id,turn_id,entry_json) SELECT t.session_id,t.id,json_object('_tag','UserTranscriptEntry','id',printf('90000000-0000-4000-8000-%012d',i),'turnId',t.id,'occurredAt','2026-09-01T10:00:00.000Z','text','Registro') FROM n JOIN hosted_turns t ON t.id=?",
        id
      )
    );
    yield* native(() =>
      db.exec(
        "UPDATE hosted_agent_sessions SET compacted_text='Resumen previo' WHERE id=(SELECT session_id FROM hosted_turns WHERE id=?)",
        id
      )
    );
  });

  const history = (turn: string): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
    native(() =>
      db.exec(
        "SELECT sequence,entry_json FROM hosted_transcript WHERE turn_id=? ORDER BY sequence",
        turn
      )
    );

  const summary = (turn: string): Effect.Effect<Awaited<ReturnType<typeof db.exec>>> =>
    native(() =>
      db.exec(
        "SELECT compacted_text,compacted_through FROM hosted_agent_sessions WHERE id=(SELECT session_id FROM hosted_turns WHERE id=?)",
        turn
      )
    );

  return { db, clock, midnight, providerCalls, owner, start, run, deliver, seed, history, summary };
});

const compaction = Effect.gen(function* () {
  const { db, clock, midnight, providerCalls, owner, start, run, deliver, seed, history, summary } =
    yield* compactionJourney();

  const before = midnight - 1000;
  yield* clock(before);
  const first = yield* run(before);
  yield* seed(first);
  const firstPrefix = yield* history(first);
  const firstSummary = yield* summary(first);
  yield* providerCalls("invalid");
  yield* run(before);
  expect(yield* history(first)).toEqual(firstPrefix);
  expect(yield* summary(first)).toEqual(firstSummary);
  expect(yield* providerCalls()).toEqual({ calls: 1 });
  yield* native(() => db.exec("UPDATE hosted_agent_sessions SET active_ms=?", before - 86400000));
  const second = yield* run(before);
  yield* seed(second);
  const secondPrefix = yield* history(second);
  yield* run(before);
  expect(yield* providerCalls()).toEqual({ calls: 2 });
  expect(yield* history(second)).toEqual(secondPrefix);
  yield* providerCalls("held");
  const third = yield* start();
  const alarm = yield* owner("clocked-alarm?now=" + before).pipe(Effect.forkChild);

  const observed = yield* providerCalls().pipe(
    Effect.repeat({
      while: (state) => state.calls !== 3,
      times: 100,
      schedule: Schedule.spaced("30 millis"),
    })
  );

  expect(observed.calls).toBe(3);
  yield* native(() =>
    db.exec(
      "UPDATE hosted_transcript SET entry_json=json_set(entry_json,'$.id','90000000-0000-4000-8000-000000000123') WHERE sequence=(SELECT min(sequence) FROM hosted_transcript WHERE turn_id=?)",
      second
    )
  );
  const changed = yield* history(second);
  yield* providerCalls("release");
  expect((yield* Fiber.join(alarm)).status).toBe(204);
  yield* deliver(third);
  expect(yield* history(second)).toEqual(changed);
  expect(yield* summary(second)).toEqual([
    { compacted_text: "Resumen previo", compacted_through: 0 },
  ]);
  yield* providerCalls("valid");
  yield* run(before);
  expect(yield* providerCalls()).toEqual({ calls: 3 });
  expect(yield* history(second)).toEqual(changed);
  yield* clock(midnight);
  yield* run(midnight);
  expect(yield* providerCalls()).toEqual({ calls: 4 });
  expect(yield* history(second)).toEqual([]);
  expect(yield* history(first)).toEqual(firstPrefix);
  expect(
    yield* native(() =>
      db.exec("SELECT day_ms,used FROM hosted_compaction_budgets ORDER BY day_ms")
    )
  ).toEqual([
    { day_ms: midnight - dayMs, used: 3 },
    { day_ms: midnight, used: 1 },
  ]);
  yield* native(() =>
    db.exec(
      "UPDATE hosted_agent_sessions SET active_ms=CASE WHEN id=(SELECT session_id FROM hosted_turns WHERE id=?) THEN ? ELSE active_ms-86400000 END",
      first,
      midnight
    )
  );
  yield* native(() =>
    db.exec(
      "CREATE TRIGGER hold_prefix BEFORE DELETE ON hosted_transcript WHEN OLD.sequence=(SELECT min(sequence) FROM hosted_transcript) BEGIN SELECT RAISE(IGNORE); END"
    )
  );
  yield* run(midnight);
  expect(yield* providerCalls()).toEqual({ calls: 5 });
  expect(yield* history(first)).toEqual(firstPrefix);
  expect(yield* summary(first)).toEqual(firstSummary);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "preserves the exact Transcript and prior summary for invalid and stale Compaction and renews three shared Session attempts at UTC midnight",
    () => compaction
  );
});
