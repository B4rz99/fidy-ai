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

const httpAccepted = 202;
const observeProposal = Effect.fn(function* (
  post: (path: string, body: unknown) => Effect.Effect<Response>,
  turnId: string
) {
  const res = yield* post("/progress", { turnId });
  return yield* Schema.decodeUnknownEffect(HostedTurnProposal)(yield* native(() => res.json()));
});
export const journey = Effect.fn(function* () {
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
    expect(res.status).toBe(httpAccepted);
    const accepted = yield* Schema.decodeUnknownEffect(HostedTurnProcessing)(
      yield* native(() => res.json())
    );
    return accepted.turnId;
  });
  const proposal = (turnId: string): ReturnType<typeof observeProposal> =>
    observeProposal(post, turnId).pipe(
      Effect.retry({ times: 80, schedule: Schedule.spaced("30 millis") })
    );
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
