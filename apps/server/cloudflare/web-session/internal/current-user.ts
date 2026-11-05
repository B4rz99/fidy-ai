import { Clock, Effect, Option, Schema } from "effect";
import { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import { prepareBrowserSessionLookup } from "./authentication";
import { prepareBrowserMetadata } from "./metadata";
import { json, noSession, unavailable } from "./support";

/** Exact cookie, renewal, canonical metadata, taxonomy and identity Audit share one transaction. */
export const currentUser = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const lookup = yield* Effect.tryPromise(() =>
      prepareBrowserSessionLookup({ request, current, mounted: false })
    );
    if (Option.isNone(lookup)) return noSession();
    const prepared = prepareBrowserMetadata({ db, lookup: lookup.value, current });
    const rows = yield* Effect.tryPromise(() => db.batch([...prepared.statements])).pipe(
      Effect.uninterruptible
    );
    if (rows[0]?.meta.changes !== 1) return noSession();
    const profile = yield* prepared.decode(rows);
    if (Option.isNone(profile)) return unavailable();
    const body = yield* Schema.encodeEffect(CurrentUserMetadata)(profile.value);
    return json({ body, status: 200, headers: {} });
  }).pipe(Effect.orElseSucceed(unavailable));
