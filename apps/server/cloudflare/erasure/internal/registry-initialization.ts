import { Effect, Schema } from "effect";
import type { ErasureRegistryInitialization } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { generationKey } from "./generation";

export const initializeRegistryStorage = <Requirements>(
  input: ErasureRegistryInitialization<Requirements> &
    Readonly<{ mode: "FirstRelease" | "LocalStartup" }>
): Effect.Effect<void, ErasureUnavailable, Requirements> =>
  Effect.gen(function* () {
    const exists = yield* input.exists(generationKey);
    if (input.mode === "LocalStartup" && exists) return;
    const raw =
      yield* input.query(`SELECT EXISTS(SELECT 1 FROM erasure_generation WHERE id=1 AND generation='initial')
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE decision_json IS NOT NULL) AS ready`);
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ ready: Schema.Literals([0, 1]) })
    )(raw);
    if (row.ready !== 1) return yield* new ErasureUnavailable();
    if (exists) return;
    if (!(yield* input.empty)) return yield* new ErasureUnavailable();
    if (!(yield* input.install(generationKey, "initial"))) return yield* new ErasureUnavailable();
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
