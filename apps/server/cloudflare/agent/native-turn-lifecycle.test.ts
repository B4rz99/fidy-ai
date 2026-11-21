import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob } from "../financial-user-store.test-fixture";
import { native } from "../user-store.test-fixture";

import { journey } from "./turn-journey.test-fixture";

const interrupted = {
  state: "interrupted",
  answer: null,
  receipt_value: null,
  receipt_digest: null,
};

const till = Effect.fn(function* <A>(probe: Effect.Effect<A>, ready: (value: A) => boolean) {
  return yield* probe.pipe(
    Effect.repeat({ until: ready, schedule: Schedule.spaced("30 millis") }),
    Effect.timeout("8 seconds")
  );
});

const malformedModel = Effect.gen(function* () {
  const { provider, start, state, entries } = yield* journey();
  yield* native(() => provider.fetch("https://fixture.invalid/malformed"));
  yield* start();
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  const rows = yield* till(state(), (value) => value[0]?.state === "failed");
  expect(rows).toEqual([{ ...interrupted, state: "failed" }]);
  expect(yield* entries()).toEqual([
    { tag: "UserTranscriptEntry" },
    { tag: "FailedTurnTranscriptEntry" },
  ]);
});

const expiredReceipt = Effect.gen(function* () {
  const { db, provider, start, proposal, post, state, entries, now } = yield* journey();
  const turnId = yield* start();
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  const visible = yield* proposal(turnId);
  yield* native(() => db.exec("UPDATE hosted_turns SET deadline_ms=? WHERE id=?", now - 1, turnId));
  const result = yield* post("/delivery", { turnId, receipt: visible.receipt });
  expect(result.status).toBe(401);
  expect(yield* state()).toEqual([interrupted]);
  expect(yield* entries()).not.toContainEqual({ tag: "AssistantTranscriptEntry" });
  expect(yield* entries()).toContainEqual({ tag: "InterruptedTurnTranscriptEntry" });
});

const liveSession = Effect.gen(function* () {
  const { db, provider, start, proposal, post, state, entries, now } = yield* journey();
  const turnId = yield* start();
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  const visible = yield* proposal(turnId);
  const receipt = { turnId, receipt: visible.receipt };
  expect((yield* post("/delivery", receipt, bob)).status).toBe(401);
  yield* native(() =>
    db.exec("UPDATE web_sessions SET revoked_at_ms=? WHERE id=?", now, alice.session)
  );
  expect((yield* post("/delivery", receipt)).status).toBe(401);
  expect((yield* state())[0]?.state).toBe("proposed");
  expect(yield* entries()).not.toContainEqual({ tag: "AssistantTranscriptEntry" });
});

const cancelInFlight = Effect.fn(function* (
  db: Effect.Success<ReturnType<typeof journey>>["db"],
  path: string,
  body: string
) {
  const user = (yield* native(() =>
    db.runtime.getDurableObjectNamespace("USER_STORE", "core")
  )).getByName(alice.user);

  yield* native(() =>
    user.fetch("https://fixture.invalid/pause-" + (path === "" ? "admission" : "progress"))
  );

  const provider = (yield* native(() =>
    db.runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  )).getByName("provider");

  const outstanding = provider.fetch(
    "https://fixture.invalid/browser-" + (path === "" ? "admission" : "progress"),
    { method: "POST", body }
  );

  yield* till(
    native(() =>
      user.fetch("https://fixture.invalid/entered").then((response) => response.json())
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ arrived: Schema.Boolean }))),
      Effect.orDie
    ),
    (value) => value.arrived
  ).pipe(Effect.catchTag("TimeoutError", () => Effect.die("owner not entered")));
  yield* native(() => provider.fetch("https://fixture.invalid/disconnect-browser"));
  expect((yield* native(() => outstanding)).status).toBe(499);
  yield* till(
    native(() =>
      user.fetch("https://fixture.invalid/entered").then((response) => response.json())
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ aborted: Schema.Boolean }))),
      Effect.orDie
    ),
    (value) => value.aborted
  ).pipe(Effect.catchTag("TimeoutError", () => Effect.die("owner did not observe disconnect")));
  yield* native(() => user.fetch("https://fixture.invalid/resume"));
});

const interruptedAdmission = Effect.gen(function* () {
  const { db, state, entries, provider } = yield* journey();
  yield* cancelInFlight(db, "", '{"text":"Pregunta no confirmada"}');
  yield* Effect.sleep("100 millis");
  expect(yield* state()).toEqual([]);
  expect(yield* entries()).toEqual([]);
  expect(
    yield* native(() =>
      provider.fetch("https://fixture.invalid/waiting").then((response) => response.json())
    )
  ).toMatchObject({ rounds: 0 });
});

const abortedPoll = Effect.gen(function* () {
  const { db, start, provider, post, state, entries, now } = yield* journey();
  const turnId = yield* start();
  yield* till(
    native(() => provider.fetch("https://fixture.invalid/waiting").then((res) => res.json())).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ waiting: Schema.Boolean }))),
      Effect.orDie
    ),
    (value) => value.waiting
  );

  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ turnId: Schema.String }))
  )({ turnId });

  yield* cancelInFlight(db, "/progress", body);
  yield* native(() => provider.fetch("https://fixture.invalid/release"));
  yield* till(state(), (value) => value[0]?.state === "proposed");
  yield* native(() => db.exec("UPDATE hosted_turns SET deadline_ms=? WHERE id=?", now - 1, turnId));
  expect((yield* post("/progress", { turnId })).status).toBe(503);
  expect(yield* state()).toEqual([interrupted]);
  expect(yield* entries()).not.toContainEqual({ tag: "AssistantTranscriptEntry" });
});

const missedAlarm = Effect.gen(function* () {
  const { db, user, provider, start, state, entries, now } = yield* journey();
  yield* native(() => user.fetch("https://fixture.invalid/hold-alarm"));
  const turnId = yield* start();
  yield* till(
    native(() =>
      user.fetch("https://fixture.invalid/missed-alarm").then((response) => response.json())
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ missed: Schema.Boolean }))),
      Effect.orDie
    ),
    (value) => value.missed
  );
  yield* native(() => db.exec("UPDATE hosted_turns SET deadline_ms=? WHERE id=?", now - 1, turnId));
  yield* native(() => user.fetch("https://fixture.invalid/resume-alarm"));
  expect((yield* native(() => db.checkWork(alice.user))).status).toBe(204);
  yield* till(state(), (value) => value[0]?.state === "interrupted");
  expect((yield* native(() => db.checkWork(alice.user))).status).toBe(204);
  expect(yield* state()).toEqual([interrupted]);
  expect(yield* entries()).toEqual([
    { tag: "UserTranscriptEntry" },
    { tag: "InterruptedTurnTranscriptEntry" },
  ]);
  expect(
    yield* native(() => provider.fetch("https://fixture.invalid/waiting").then((res) => res.json()))
  ).toMatchObject({ rounds: 0 });
});

const refusedAdmission = Effect.gen(function* () {
  const { db, provider, post, entries, now } = yield* journey();
  expect((yield* post("", { text: "Primera pregunta" }, bob)).status).toBe(403);
  yield* native(() =>
    db.exec(
      "INSERT INTO hosted_agent_sessions(id,user_id,basis_json,start_ms,active_ms) VALUES(?,?,'{}',?,?)",
      alice.session,
      alice.user,
      now,
      now
    )
  );
  yield* native(() =>
    db.exec(
      "WITH RECURSIVE counts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counts WHERE n<10) INSERT INTO hosted_turns(id,user_id,session_id,start_ms,deadline_ms,request_text,state,terminal_ms) SELECT printf('22000000-0000-4000-8000-%012d',n),?,?,?,?,'past','failed',? FROM counts",
      alice.user,
      alice.session,
      now,
      now,
      now
    )
  );

  yield* Effect.forEach(
    ["Otra pregunta", "Nueva pregunta"],
    Effect.fnUntraced(function* (text) {
      expect((yield* post("", { text })).status).toBe(429);
    }),
    { discard: true }
  );

  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,grant_record_id,session_id,occurred_at_ms) VALUES(?,?,'processing_withdrawal',?,?,?)",
      alice.user,
      alice.user,
      bob.user,
      alice.session,
      now
    )
  );
  expect((yield* post("", { text: "Consulta" })).status).toBe(403);
  yield* native(() =>
    db.exec("UPDATE web_sessions SET idle_expires_at_ms=? WHERE id=?", now - 1, alice.session)
  );
  expect((yield* post("", { text: "Consulta" })).status).toBe(401);
  expect(yield* entries()).toEqual([]);
  expect(yield* native(() => db.exec("SELECT count(*) AS n FROM hosted_turns"))).toEqual([
    { n: 10 },
  ]);
  expect(
    yield* native(() => provider.fetch("https://fixture.invalid/waiting").then((res) => res.json()))
  ).toMatchObject({ rounds: 0 });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "disconnecting admission in flight before the addressed User starts its transaction retains no Turn or provider work",
    () => interruptedAdmission
  );
  test.effect(
    "discards malformed model output without retaining an assistant or delivery proof",
    () => malformedModel
  );
  test.effect(
    "declines an expired visible receipt and interrupts its original Turn before acknowledging delivery",
    () => expiredReceipt
  );
  test.effect(
    "refuses delivery for a different User or a WebSession revoked after the proposal",
    () => liveSession
  );
  test.effect(
    "an aborted browser poll during inference cannot acknowledge a reply; the undelivered proposal expires without an assistant entry",
    () => abortedPoll
  );
  test.effect(
    "recovers a committed Turn after a lost alarm delivery and fences the expired provider work on repeated probes",
    () => missedAlarm
  );
  test.effect(
    "repeated exhausted, withdrawn and stale browser requests leave hosted evidence and provider spend unchanged",
    () => refusedAdmission
  );
});
