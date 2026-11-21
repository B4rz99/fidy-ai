import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { alice, makeNativeTransactionJourney } from "../../financial-user-store.test-fixture";
import { native, nativeClockPlatform } from "../../user-store.test-fixture";

const now = 946684800000;

const created = now - 1000;

const idle = now + 600000;

const hard = created + 7776000000;

const sessionColumns =
  "SELECT created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms,revoked_at_ms FROM web_sessions WHERE id=?";

type Journey = Effect.Success<ReturnType<typeof makeNativeTransactionJourney>>;

const malformedHostedRequest = Effect.fn(function* (journey: Journey, path: string) {
  const response = yield* native(() =>
    journey.send(
      new Request("https://api.fidyapp.com" + path, {
        method: "POST",
        headers: {
          origin: "https://app.fidyapp.com",
          cookie: "__Host-fidy_session=" + alice.bearer,
          "Fidy-Session-Binding": alice.session,
          "content-type": "application/json",
        },
        body: "{",
      })
    )
  );

  expect(response.status, path).toBe(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(yield* native(() => response.json())).toEqual({ status: "validation_failed" });
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "validates malformed hosted requests against the live invocation clock without extending the Session or admitting work",
    () =>
      Effect.gen(function* () {
        const journey = yield* makeNativeTransactionJourney(undefined, nativeClockPlatform);

        const sql = (
          ...args: Parameters<typeof journey.exec>
        ): Effect.Effect<Awaited<ReturnType<typeof journey.exec>>> =>
          native(() => journey.exec(...args));

        expect(yield* sql("SELECT unixepoch('subsec')*1000 > ? AS expired", hard)).toEqual([
          { expired: 1 },
        ]);
        yield* sql("CREATE TABLE fixture_clock(instant INTEGER NOT NULL) STRICT");
        yield* sql("INSERT INTO fixture_clock VALUES(?)", now);
        yield* sql(
          "UPDATE web_sessions SET created_at_ms=?,fresh_until_ms=?,idle_expires_at_ms=?,hard_expires_at_ms=? WHERE id=?",
          created,
          created + 600000,
          idle,
          hard,
          alice.session
        );
        const session = yield* sql(sessionColumns, alice.session);

        yield* Effect.forEach(
          ["/web/hosted-turns", "/web/hosted-turns/progress", "/web/hosted-turns/delivery"],
          (path) => malformedHostedRequest(journey, path),
          { discard: true }
        );

        expect(yield* sql(sessionColumns, alice.session)).toEqual(session);
        expect(
          yield* sql(
            "SELECT (SELECT count(*) FROM hosted_turns) AS turns, (SELECT count(*) FROM hosted_transcript) AS entries, (SELECT count(*) FROM audit_entries WHERE record_type='identity_read') AS identityReads, (SELECT count(*) FROM commercial_allowance_consumptions) AS charges"
          )
        ).toEqual([{ turns: 0, entries: 0, identityReads: 0, charges: 0 }]);
      })
  );
});
