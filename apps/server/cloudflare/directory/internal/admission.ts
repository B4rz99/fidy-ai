import { Clock, Effect, Option } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { unavailable } from "../../browser-login/operations";

const minute = 60000;
const limitReply = (): Response =>
  Response.json(
    { status: "limited" },
    { status: 429, headers: { "cache-control": "no-store", "retry-after": "60" } }
  );
type Window = Readonly<{ scope: string; limit: number; duration: number }>;
export const chargeBootstrapWindows = Effect.fn(function* (windows: ReadonlyArray<Window>) {
  const sql = yield* SqliteClient;
  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* sql`DELETE FROM bootstrap_admissions WHERE id IN(SELECT id FROM bootstrap_admissions WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT 32)`;
    for (const window of windows) {
      const [full] =
        yield* sql`SELECT id FROM bootstrap_admissions WHERE scope=${window.scope} AND expires_at_ms>${now} LIMIT 1 OFFSET ${window.limit - 1}`;
      if (full !== undefined) return Option.some(limitReply());
    }
    for (const window of windows) {
      yield* sql`INSERT INTO bootstrap_admissions(scope,expires_at_ms) VALUES(${window.scope},${now + window.duration})`;
    }
    return Option.none<Response>();
  }).pipe(withStoreCapacity("growth"));
});
export const admitBootstrap = Effect.fn(function* (request: Request) {
  const source = request.headers.get("x-provider-source") ?? "";
  if (!/^[a-f0-9]{64}$/u.test(source)) return Option.some(unavailable());
  const path = new URL(request.url).pathname;
  const cheap =
    path.endsWith("/status") || path.endsWith("/disclosure") || path.endsWith("/redeem");
  return yield* chargeBootstrapWindows([
    { scope: "source:" + source, limit: 120, duration: minute },
    { scope: "global", limit: 1200, duration: minute },
    ...(cheap
      ? []
      : [
          { scope: "exchange:" + source, limit: 30, duration: minute },
          { scope: "exchanges", limit: 300, duration: minute },
        ]),
  ]);
});
