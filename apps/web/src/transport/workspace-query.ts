import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { Effect, Option, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { forwardFreshQuery, freshQuery } from "./fresh-query";
import type { CanonicalSuccess, FidyClient } from "./client";

type Client = FidyClient["Service"];

type ProfileError = Effect.Error<ReturnType<Client["identity"]["getCurrentUser"]>>;

type CatalogError = Effect.Error<ReturnType<Client["dashboard"]["listDashboardCatalog"]>>;

type ProfileQuery = Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"identity.getCurrentUser">, ProfileError>
>;

type CategoriesQuery = Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"categories.listCategories">, ProfileError>
>;

type CatalogQuery = Atom.Atom<
  AsyncResult.AsyncResult<CanonicalSuccess<"dashboard.listDashboardCatalog">, CatalogError>
>;

export const workspaceQueryRetention = { timeToLive: "5 minutes" } as const;

export const revalidateWorkspaceQuery = <A, E>(
  query: Atom.Atom<AsyncResult.AsyncResult<A, E>>
): Atom.Atom<AsyncResult.AsyncResult<A, E>> =>
  query.pipe(
    Atom.swr({
      staleTime: "5 seconds",
      revalidateOnMount: true,
      revalidateOnFocus: true,
      focusSignal: Atom.windowFocusSignal,
    })
  );

type MetadataValue = Option.Option<
  AsyncResult.AsyncResult<CanonicalSuccess<"identity.getCurrentUser">, ProfileError>
>;

const initialMetadata: (client: FidyClient) => Atom.Writable<MetadataValue, MetadataValue> =
  Atom.family((_client: FidyClient) =>
    Atom.make<
      Option.Option<
        AsyncResult.AsyncResult<CanonicalSuccess<"identity.getCurrentUser">, ProfileError>
      >
    >(Option.none()).pipe(Atom.setIdleTTL("400 millis"))
  );

const workspaceMetadataQuery = Atom.family((client: FidyClient) => {
  const remote = freshQuery({
    runtime: client.runtime,
    load: client
      .use((api) => api.identity.getCurrentUser())
      .pipe(
        Effect.catchIf(
          (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
          Effect.die
        )
      ),
    decorate: Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
  });

  const source = Atom.readable(
    (get) => {
      const current = Option.getOrElse(get(initialMetadata(client)), () => get(remote));

      return AsyncResult.isInitial(current)
        ? AsyncResult.waitingFrom(
            get.self<
              AsyncResult.AsyncResult<CanonicalSuccess<"identity.getCurrentUser">, ProfileError>
            >()
          )
        : current;
    },
    (refresh) => {
      refresh(remote);
      refresh(initialMetadata(client));
    }
  ).pipe(
    client.runtime.factory.withReactivity(["recurring-resume"]),
    Atom.setIdleTTL(workspaceQueryRetention.timeToLive)
  );

  return forwardFreshQuery({
    query: source,
    sources: [remote],
    before: (registry) => registry.set(initialMetadata(client), Option.none()),
  });
});

export const workspaceMetadataInitialValue = ({
  client,
  value,
  timestamp,
}: Readonly<{
  client: FidyClient;
  value: CanonicalSuccess<"identity.getCurrentUser">;
  timestamp: number;
}>): readonly [
  ReturnType<typeof initialMetadata>,
  Option.Option<AsyncResult.AsyncResult<CanonicalSuccess<"identity.getCurrentUser">, ProfileError>>,
] => [initialMetadata(client), Option.some(AsyncResult.success(value, { timestamp }))] as const;

export const retainPreparedWorkspaceMetadata = ({
  client,
  registry,
}: Readonly<{ client: FidyClient; registry: AtomRegistry.AtomRegistry }>): void => {
  if (Option.isSome(registry.get(initialMetadata(client)))) {
    registry.get(workspaceMetadataQuery(client));
  }
};

export const workspaceProfileQuery: (client: FidyClient) => ProfileQuery = Atom.family(
  (client: FidyClient) =>
    forwardFreshQuery({
      query: workspaceMetadataQuery(client).pipe(revalidateWorkspaceQuery),
      sources: [workspaceMetadataQuery(client)],
    })
);

const workspaceCategoriesSource: (client: FidyClient) => CategoriesQuery = Atom.family(
  (client: FidyClient) => {
    const individual = freshQuery({
      runtime: client.runtime,
      load: client
        .use((api) => api.categories.listCategories())
        .pipe(
          Effect.catchIf(
            (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
            Effect.die
          )
        ),
      decorate: (query) =>
        query.pipe(
          Atom.setIdleTTL(workspaceQueryRetention.timeToLive),
          client.runtime.factory.withReactivity(["recurring-resume"]),
          Atom.setIdleTTL(workspaceQueryRetention.timeToLive)
        ),
    });

    const metadata = workspaceMetadataQuery(client);

    const source: CategoriesQuery = Atom.readable(
      (get) => {
        const profile = get(metadata);
        const categories = Option.flatMap(AsyncResult.value(profile), (value) => value.categories);

        if (Option.isSome(categories)) {
          return AsyncResult.map(profile, () => ({ data: categories.value, next: [] }));
        }

        return AsyncResult.isInitial(profile)
          ? AsyncResult.initial(profile.waiting)
          : get(individual);
      },
      (refresh) => {
        refresh(metadata);
        refresh(individual);
      }
    );

    return forwardFreshQuery({ query: source, sources: [metadata, individual] });
  }
);

const workspaceCategoriesView = Atom.family((client: FidyClient) =>
  forwardFreshQuery({
    query: workspaceCategoriesSource(client).pipe(revalidateWorkspaceQuery),
    sources: [workspaceCategoriesSource(client)],
  })
);

export type WorkspaceCategoriesQueries = Readonly<{
  source: CategoriesQuery;
  view: CategoriesQuery;
}>;

export const workspaceCategoriesQuery = (client: FidyClient): WorkspaceCategoriesQueries => ({
  source: workspaceCategoriesSource(client),
  view: workspaceCategoriesView(client),
});

export const workspaceDashboardCatalogQuery: (client: FidyClient) => CatalogQuery = Atom.family(
  (client: FidyClient) =>
    client
      .query("dashboard", "listDashboardCatalog", workspaceQueryRetention)
      .pipe(revalidateWorkspaceQuery)
);
