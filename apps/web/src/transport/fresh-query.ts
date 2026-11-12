import { queryLifetime } from "./query-lifetime";
import { Deferred, Effect, Exit, Option } from "effect";
import { type AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;
type Request = { claimed: boolean; retired: boolean; completion: Deferred.Deferred<boolean> };
type FreshRead = (registry: AtomRegistry.AtomRegistry) => Effect.Effect<boolean>;
const freshReads = new WeakMap<object, FreshRead>();

/** A strict read starts a new invocation in this registry. Failure, supersession and disposal
 * cannot certify recovery; ordinary display values and refresh policy remain independent.
 */
type FreshOptions<R, ER, A, E> = Readonly<{
  runtime: Atom.AtomRuntime<R, ER>;
  load: Effect.Effect<A, E, R>;
}> &
  (Readonly<{}> | Readonly<{ decorate: (query: Query<A, E | ER>) => Query<A, E | ER> }>);

const observeFreshRead =
  <R, ER, A, E>({
    runtime,
    query,
    requested,
  }: Readonly<{
    runtime: Atom.AtomRuntime<R, ER>;
    query: Query<A, E>;
    requested: Atom.Writable<Option.Option<Request>, Option.Option<Request>>;
  }>): FreshRead =>
  (registry) =>
    Effect.gen(function* () {
      const lifetime = queryLifetime(registry);
      if (!lifetime.active()) return false;
      const completion = yield* Deferred.make<boolean>();
      const releaseLifetime = lifetime.observe(() =>
        Deferred.doneUnsafe(completion, Effect.succeed(false))
      );
      const previous = registry.get(requested);
      if (Option.isSome(previous)) {
        Deferred.doneUnsafe(previous.value.completion, Effect.succeed(false));
      }
      const request = { claimed: false, retired: false, completion };
      registry.set(requested, Option.some(request));
      const unmount = registry.mount(query);
      const unsubscribe = registry.subscribe(
        runtime,
        (result) => {
          if (result._tag === "Failure" && !result.waiting) {
            Deferred.doneUnsafe(completion, Effect.succeed(false));
          }
        },
        { immediate: true }
      );
      return yield* Deferred.await(completion).pipe(
        Effect.flatMap((success) =>
          success
            ? AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
                Effect.exit,
                Effect.map(
                  (result) => Exit.isSuccess(result) && !request.retired && lifetime.active()
                )
              )
            : Effect.succeed(false)
        ),
        Effect.ensuring(
          Effect.sync(() => {
            request.retired = true;
            unsubscribe();
            unmount();
            releaseLifetime();
          })
        )
      );
    });

export const makeFreshQuery = <R, ER, A, E>(
  options: FreshOptions<R, ER, A, E>
): Query<A, E | ER> => {
  const { runtime, load } = options;
  const requested = Atom.make<Option.Option<Request>>(Option.none());
  const source = runtime.atom((get) => {
    queryLifetime(get.registry);
    const request = get(requested);
    get.addFinalizer(() => {
      if (Option.isSome(request)) {
        request.value.retired = true;
        Deferred.doneUnsafe(request.value.completion, Effect.succeed(false));
      }
    });
    return Effect.suspend(() => {
      if (Option.isNone(request) || request.value.claimed) return load;
      request.value.claimed = true;
      return load.pipe(
        Effect.onExit((result) =>
          Deferred.succeed(request.value.completion, Exit.isSuccess(result)).pipe(Effect.asVoid)
        )
      );
    });
  });
  const query = "decorate" in options ? options.decorate(source) : source;
  freshReads.set(query, observeFreshRead({ runtime, query, requested }));
  return query;
};

/** Associate a retained/SWR projection with its real loader, retiring supplied initial data first. */
export const forwardFreshQuery = <A, E>(
  options: Readonly<{
    query: Query<A, E>;
    sources:
      | ReadonlyArray<Query<unknown, unknown>>
      | ((registry: AtomRegistry.AtomRegistry) => ReadonlyArray<Query<unknown, unknown>>);
  }> &
    (Readonly<{}> | Readonly<{ before: (registry: AtomRegistry.AtomRegistry) => void }>)
): Query<A, E> => {
  const { query, sources } = options;
  freshReads.set(query, (registry) =>
    Effect.suspend(() => {
      if ("before" in options) options.before(registry);
      const currentSources = typeof sources === "function" ? sources(registry) : sources;
      return Effect.forEach(currentSources, (query) => readFreshQuery({ registry, query })).pipe(
        Effect.map((results) => results.every(Boolean))
      );
    })
  );
  return query;
};

export const readFreshQuery = <A, E>({
  registry,
  query,
}: Readonly<{
  registry: AtomRegistry.AtomRegistry;
  query: Query<A, E>;
}>): Effect.Effect<boolean> =>
  Effect.suspend(() =>
    queryLifetime(registry).active()
      ? (freshReads.get(query)?.(registry) ?? Effect.succeed(false))
      : Effect.succeed(false)
  );
