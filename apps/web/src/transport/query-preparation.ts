import { Effect, Option } from "effect";
import { browserRuntime } from "./browser-runtime";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";

export const prepareQuery = <A, E>({
  registry,
  query,
  options,
}: Readonly<{
  registry: AtomRegistry.AtomRegistry;
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  options: Readonly<{
    mode: "cached" | "fresh" | "display" | "refresh-display";
    signal: Option.Option<AbortSignal>;
  }>;
}>): Promise<void> =>
  browserRuntime
    .runPromise(
      Effect.gen(function* () {
        const current = registry.get(query);

        if ((options.mode === "fresh" || options.mode === "refresh-display") && !current.waiting) {
          registry.refresh(query);
          registry.get(query);
        }

        if (
          (options.mode === "display" || options.mode === "refresh-display") &&
          Option.isSome(AsyncResult.value(current))
        ) {
          return;
        }

        yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      }).pipe(Effect.ignoreCause),
      { signal: Option.getOrUndefined(options.signal) }
    )
    .catch(() => undefined);

export const preparationActive = (signal: AbortSignal): boolean => !signal.aborted;
