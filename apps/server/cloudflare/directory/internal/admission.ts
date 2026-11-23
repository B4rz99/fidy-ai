import { Clock, Effect, Option } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { unavailable } from "../../browser-login/operations";

const minute = 60000;

const pairingStartDuration = 600_000;

const limitReply = (): Response =>
  Response.json(
    { status: "limited" },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
  );

type Window = Readonly<{ scope: string; limit: number; duration: number }>;

const windowFull = Effect.fn(function* (window: Window, now: number) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT id FROM bootstrap_admissions WHERE scope=${window.scope} AND expires_at_ms>${now} LIMIT 1 OFFSET ${window.limit - 1}`;

  return rows.length > 0;
});

export const chargeBootstrapWindows = Effect.fn(function* (windows: ReadonlyArray<Window>) {
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM bootstrap_admissions WHERE id IN(SELECT id FROM bootstrap_admissions WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT 32)`;

    const full = yield* Effect.findFirst(windows, (window) => windowFull(window, now));

    if (Option.isSome(full)) return Option.some(limitReply());

    yield* Effect.forEach(
      windows,
      (window) =>
        sql`INSERT INTO bootstrap_admissions(scope,expires_at_ms) VALUES(${window.scope},${now + window.duration})`,
      { discard: true }
    );

    return Option.none<Response>();
  }).pipe(withStoreCapacity("growth"));
});

export const admitBootstrap = Effect.fn(function* (request: Request) {
  const source = request.headers.get("x-provider-source") ?? "";

  if (!/^[a-f0-9]{64}$/u.test(source)) return Option.some(unavailable());
  const path = new URL(request.url).pathname;

  const cheap =
    path.endsWith("/status") || path.endsWith("/disclosure") || path.endsWith("/redeem");

  const exchangeWindows = cheap
    ? []
    : [
        { scope: "exchange:" + source, limit: 30, duration: minute },
        { scope: "exchanges", limit: 300, duration: minute },
      ];

  return yield* chargeBootstrapWindows([
    { scope: "source:" + source, limit: 120, duration: minute },
    { scope: "global", limit: 1200, duration: minute },
    ...exchangeWindows,
  ]);
});

export const admitPATPairingStart = Effect.fn(function* (request: Request) {
  const source = request.headers.get("x-pat-source") ?? "";

  if (!/^[a-f0-9]{64}$/u.test(source)) return Option.some(unavailable());

  return yield* chargeBootstrapWindows([
    { scope: "pat-pairing:source:" + source, limit: 20, duration: pairingStartDuration },
    { scope: "pat-pairing:global", limit: 600, duration: minute },
  ]);
});
