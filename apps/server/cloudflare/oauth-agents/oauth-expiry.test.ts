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
        fixture.db.prepare("UPDATE oauth_codes SET expires_at_ms = ?").bind(expires).run()
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
            .prepare("SELECT count(*) FROM oauth_codes WHERE consumed_at_ms IS NOT NULL")
            .first<number>("count(*)")
        )
      ).toBe(0);
      expect(
        yield* wait(
          fixture.db
            .prepare("SELECT count(*) FROM oauth_access_credentials")
            .first<number>("count(*)")
        )
      ).toBe(0);
    })
  ));

it.each(["code", "refresh"] as const)(
  "uses D1 time when consuming a %s despite an earlier application clock",
  (kind) =>
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
        const table = kind === "code" ? "oauth_codes" : "oauth_refresh_credentials";
        const current =
          (yield* wait(
            fixture.db
              .prepare("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 AS current")
              .first<number>("current")
          )) ?? 0;
        // A previously prepared unit reaches D1 after its credential has expired.
        yield* wait(
          fixture.db
            .prepare(
              `UPDATE ${table} SET expires_at_ms = ?${kind === "refresh" ? ", issued_at_ms = ?" : ""}`
            )
            .bind(...(kind === "refresh" ? [current - 1, current - 2000] : [current - 1]))
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
        expect(
          yield* wait(
            fixture.db
              .prepare(`SELECT count(*) FROM ${table} WHERE consumed_at_ms IS NOT NULL`)
              .first<number>("count(*)")
          )
        ).toBe(0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_access_credentials")
              .first<number>("count(*)")
          )
        ).toBe(kind === "refresh" ? 1 : 0);
        expect(
          yield* wait(
            fixture.db
              .prepare("SELECT count(*) FROM oauth_refresh_events")
              .first<number>("count(*)")
          )
        ).toBe(0);
      })
    )
);
