import { Effect, Option } from "effect";
import type { ErasureOperatorEnvironment } from "../contract";
import { initializeRegistryStorage } from "./registry-initialization";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { expectedGeneration } from "./generation";

const successStatus = 204;
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
/** First-release operator action only. After any approved case, loss of the checkpoint requires recovery of the independent registry. */
export const initializeRegistry = (
  environment: ErasureOperatorEnvironment
): Effect.Effect<Response, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = Option.fromUndefinedOr(environment.ERASURE_BUCKET);
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    yield* initializeRegistryStorage({
      mode: "FirstRelease",
      query: (statement) => io(() => environment.DB.prepare(statement).first()),
      exists: (key) =>
        io(() => bucket.value.head(key)).pipe(Effect.map((object) => object !== null)),
      empty: io(() => bucket.value.list({ limit: 1 })).pipe(
        Effect.map((page) => page.objects.length === 0)
      ),
      install: (key, value) =>
        io(() => bucket.value.put(key, value, { onlyIf: { etagDoesNotMatch: "*" } })).pipe(
          Effect.map((object) => object !== null)
        ),
    });
    const checkpoint = yield* expectedGeneration({ db: environment.DB, bucket });
    if (checkpoint.generation !== "initial") return yield* new ErasureUnavailable();
    return new Response(null, { status: successStatus, headers: { "cache-control": "no-store" } });
  });
