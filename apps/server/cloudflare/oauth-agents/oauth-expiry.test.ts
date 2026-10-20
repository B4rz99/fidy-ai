import { Clock, Effect, Option, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { exchangeToken } from "./internal/exchange";
import {
  TokenFixture,
  approvedFixture,
  exchangeFixture,
  refreshFixture,
  wait,
} from "./oauth-ingress.test-fixture";

afterEach(() => vi.restoreAllMocks());

it("rechecks code expiration after the token request body finishes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* approvedFixture();
      const started = yield* Clock.currentTimeMillis;
      const expires = started + 1000;
      yield* wait(
        fixture.db
          .prepare(
            "UPDATE oauth_connections AS oauth_codes SET code_expires_at_ms = ? WHERE code_digest IS NOT NULL "
          )
          .bind(expires)
          .run()
      );
      const liveClock = yield* Clock.Clock;
      let current = started;
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => current,
        currentTimeMillis: Effect.sync(() => current),
        currentTimeNanosUnsafe: () => BigInt(current) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(current) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: liveClock.monotonicTimeNanos,
        sleep: (duration) => liveClock.sleep(duration),
      };
      const response = yield* exchangeToken({
        db: fixture.db,
        current: started,
        request: new Request("https://api.fidyapp.com/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new ReadableStream<Uint8Array>(
            {
              pull(controller): void {
                current = expires;
                controller.enqueue(new TextEncoder().encode(fixture.body.toString()));
                controller.close();
              },
            },
            { highWaterMark: 0 }
          ),
        }),
        coordinator: {
          getByName: (): Pick<Fetcher, "fetch"> => ({
            fetch: () => Promise.reject(new Error("Code exchange must not refresh.")),
          }),
        },
        admitUser: () => Effect.void,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      expect(response.status).toBe(400);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT rowid,code_digest AS digest,id AS connection_id,code_challenge AS challenge,code_expires_at_ms AS expires_at_ms,code_consumed_at_ms AS consumed_at_ms FROM oauth_connections WHERE code_digest IS NOT NULL) AS oauth_codes WHERE consumed_at_ms IS NOT NULL"
            )
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare(
              "SELECT count(*) FROM (SELECT rowid,* FROM oauth_credentials WHERE kind='access') AS oauth_credentials"
            )
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it.each([
  {
    kind: "code",
    mutation: "UPDATE oauth_connections SET code_expires_at_ms=?",
    params: (current: number): ReadonlyArray<number> => [current - 1],
    consumed: "SELECT count(*) FROM oauth_connections WHERE code_consumed_at_ms IS NOT NULL",
  },
  {
    kind: "refresh",
    mutation: "UPDATE oauth_credentials SET expires_at_ms=?,issued_at_ms=? WHERE kind='refresh'",
    params: (current: number): ReadonlyArray<number> => [current - 1, current - 2000],
    consumed:
      "SELECT count(*) FROM oauth_credentials WHERE kind='refresh' AND consumed_at_ms IS NOT NULL",
  },
] as const)(
  "uses D1 time when consuming a $kind despite an earlier application clock",
  ({ kind, mutation, params, consumed }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* approvedFixture();
        const original =
          kind === "refresh"
            ? Option.some(
                yield* Schema.decodeUnknownEffect(TokenFixture)(
                  yield* wait((yield* wait(exchangeFixture(fixture))).json())
                )
              )
            : Option.none();
        const current =
          (yield* wait(
            fixture.db
              .prepare("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 AS current")
              .first<number>("current")
          )) ?? 0;
        yield* wait(
          fixture.db
            .prepare(mutation)
            .bind(...params(current))
            .run()
        );
        vi.spyOn(Date, "now").mockReturnValue(current - 1000);
        const response = yield* wait(
          Option.isSome(original)
            ? refreshFixture({
                ...fixture,
                refresh: original.value.refresh_token,
                scope: Option.none(),
              })
            : exchangeFixture(fixture)
        );
        expect(response.status).toBe(400);
        expect(yield* wait(response.json())).toEqual({ error: "invalid_grant" });
        expect(yield* wait(fixture.db.prepare(consumed).first<number>("count(*)"))).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT rowid,* FROM oauth_credentials WHERE kind='access') AS oauth_credentials"
              )
              .first<number>("count(*)")
          )
        ).toBe(kind === "refresh" ? 1 : 0);
        expect(
          yield* wait(
            fixture.db
              .prepare(
                "SELECT count(*) FROM (SELECT sequence AS rowid,id,user_id,refresh_connection_id AS connection_id,consumed_refresh_id AS consumed_credential_id,issued_refresh_id AS issued_credential_id,occurred_at_ms FROM audit_entries WHERE record_type='oauth_refresh')"
              )
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
