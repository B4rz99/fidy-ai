import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { HostedTurnProcessing, HostedTurnProposal } from "../../src/shell/agent/contract";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import {
  alice,
  bob,
  makeNativeTransactionJourney,
  nativeBrowserWrite,
} from "../financial-user-store.test-fixture";
import { native, nativeHostedPlatform } from "../user-store.test-fixture";

const journey = Effect.fn(function* () {
  const db = yield* makeNativeTransactionJourney(undefined, nativeHostedPlatform);
  const snapshot = yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
    currentDisclosureFor()
  );
  const now = yield* Clock.currentTimeMillis;
  yield* native(() =>
    db.exec(
      "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
      bob.user,
      alice.user,
      now,
      snapshot
    )
  );
  const reply = nativeBrowserWrite(db);
  const post = (
    path: string,
    body: unknown,
    subject: typeof alice = alice
  ): Effect.Effect<Response> =>
    reply(subject, { path: "/web/hosted-turns" + path, method: "POST", body });
  const provider = (yield* native(() =>
    db.runtime.getDurableObjectNamespace("CONTROL", "hosted-provider")
  )).getByName("provider");
  const user = (yield* native(() =>
    db.runtime.getDurableObjectNamespace("USER_STORE", "core")
  )).getByName(alice.user);
  const start = Effect.fn(function* () {
    const res = yield* post("", { text: "Consulta el saldo." });
    expect(res.status).toBe(202);
    const accepted = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
      yield* native(() => res.json())
    );
    return accepted.turnId;
  });
  const proposal = Effect.fn(function* (turnId: string) {
    return yield* Effect.retry(
      Effect.gen(function* () {
        const res = yield* post("/progress", { turnId });
        return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(
          yield* native(() => res.json())
        );
      }),
      { times: 80, schedule: Schedule.spaced("30 millis") }
    );
  });
  const state = Effect.fn(function* () {
    return yield* native(() =>
      db.exec("SELECT state,answer,receipt_value,receipt_digest FROM hosted_turns")
    );
  });
  const entries = Effect.fn(function* () {
    return yield* native(() =>
      db.exec(
        "SELECT json_extract(entry_json,'$._tag') AS tag FROM hosted_transcript ORDER BY sequence"
      )
    );
  });
  return { db, post, provider, user, start, proposal, state, entries, now };
});
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
  const aborted = yield* Effect.tryPromise(() =>
    db.runtime.dispatchFetch("https://api.fidyapp.com/web/hosted-turns/progress", {
      method: "POST",
      signal: AbortSignal.abort(),
      headers: {
        origin: "https://app.fidyapp.com",
        cookie: "__Host-fidy_session=" + alice.bearer,
        "Fidy-Session-Binding": alice.session,
        "content-type": "application/json",
      },
      body,
    })
  ).pipe(Effect.result);
  expect(aborted._tag).toBe("Failure");
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
  for (const text of ["Otra pregunta", "Nueva pregunta"]) {
    expect((yield* post("", { text })).status).toBe(429);
  }
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
