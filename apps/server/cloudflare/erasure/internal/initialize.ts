import { Effect, Option } from "effect";
import type { ErasureOperatorEnvironment } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { expectedGeneration, generationKey } from "./generation";

const successStatus = 204;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
/** First-release operator action only. Ordinary data access never creates a missing recovery checkpoint; after any approved case, loss of that checkpoint requires recovery of the independent registry. */
export const initializeRegistry = (
  environment: ErasureOperatorEnvironment
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = Option.fromUndefinedOr(environment.ERASURE_BUCKET);
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const ready = yield* io(() =>
      environment.DB.prepare(`SELECT EXISTS(SELECT 1 FROM erasure_generation WHERE id=1 AND generation='initial')
   AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE decision_json IS NOT NULL) AS ready`).first<number>(
        "ready"
      )
    );
    if (ready !== 1) return yield* new ErasureUnavailable();
    const existing = yield* io(() => bucket.value.head(generationKey));
    if (existing === null) {
      const objects = yield* io(() => bucket.value.list({ limit: 1 }));
      if (objects.objects.length > 0) return yield* new ErasureUnavailable();
      yield* io(() =>
        bucket.value.put(generationKey, "initial", { onlyIf: { etagDoesNotMatch: "*" } })
      );
    }
    const checkpoint = yield* expectedGeneration({ db: environment.DB, bucket });
    if (checkpoint.generation !== "initial") return yield* new ErasureUnavailable();
    return new Response(null, { status: successStatus, headers: { "cache-control": "no-store" } });
  });
