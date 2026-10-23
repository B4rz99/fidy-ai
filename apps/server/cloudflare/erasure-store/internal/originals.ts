import { userPrivateObjectPrefix } from "../../private-objects/operations";
import { UserId } from "../../../src/core/identity/contract";
import { Effect, Option, Schema } from "effect";
import {
  type ErasureOriginalConfiguration,
  type ErasureScope,
  ErasureUnavailable,
} from "../contract";

const maximumObjects = 4;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
/** A full-deletion request owns every temporary/original key in its User prefix, even without an inventory row. At most four objects are deleted per continuation. */
const discardUserPrefixPage = (
  input: Readonly<{ configuration: ErasureOriginalConfiguration; scope: ErasureScope }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const userId = yield* Schema.decodeEffect(UserId)(input.scope.userId);
    const prefix = userPrivateObjectPrefix(userId);
    for (const code of ["email", "statement", "retained"] as const) {
      const bucket = input.configuration[code];
      if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
      const page = yield* io(() => bucket.value.list({ prefix, limit: maximumObjects }));
      if (page.objects.length === 0) continue;
      yield* io(() => bucket.value.delete(page.objects.map((object) => object.key)));
      return true;
    }
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const discard = (
  input: Readonly<{ configuration: ErasureOriginalConfiguration; scope: ErasureScope }>
): Effect.Effect<"Done" | "Continue", ErasureUnavailable> =>
  Effect.gen(function* () {
    const approved = yield* io(() =>
      input.configuration.db
        .prepare(
          "SELECT count(*) AS approved FROM erasure_requests WHERE id=? AND user_id=? AND marker_written=1 AND coordinator_cleared=1 AND state='Erasing' AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=erasure_requests.user_id)"
        )
        .bind(input.scope.reference, input.scope.userId)
        .first<number>("approved")
    );
    if (approved !== 1) return yield* new ErasureUnavailable();
    return (yield* discardUserPrefixPage(input)) ? "Continue" : "Done";
  });
