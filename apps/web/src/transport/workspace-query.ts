import { AsyncResult, Atom } from "effect/reactivity";
import { type Context, type Effect, Option } from "effect";
import type { CanonicalSuccess, FidyClient } from "./client";

type Client = Context.Service.Shape<FidyClient>;
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
/** Retain display data only within the current authentication registry. */
export const workspaceQueryRetention = { timeToLive: "1 minute" } as const;
/** Reuse a recent display snapshot; expired results reread before editing resumes. */
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
  const remote = client.query("identity", "getCurrentUser", workspaceQueryRetention);
  return Atom.readable(
    (get) => {
      const current = Option.getOrElse(get(initialMetadata(client)), () => get(remote));
      // The first remote read has no prior value of its own; retain the owned entry display.
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
  ).pipe(client.runtime.factory.withReactivity(["recurring-resume"]), Atom.setIdleTTL("1 minute"));
});
/** The initial observation belongs to the canonical metadata owner; refresh retires it. */
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
/** All workspaces observe one profile and its optional inline display taxonomy. */
export const workspaceProfileQuery: (client: FidyClient) => ProfileQuery = Atom.family(
  (client: FidyClient) => workspaceMetadataQuery(client).pipe(revalidateWorkspaceQuery)
);
/** The browser's metadata projection supplies taxonomy; other transports can read it separately. */
const workspaceCategoriesSource: (client: FidyClient) => CategoriesQuery = Atom.family(
  (client: FidyClient) => {
    const individual = client.query("categories", "listCategories", {
      ...workspaceQueryRetention,
      reactivityKeys: ["recurring-resume"],
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
    return source;
  }
);
const workspaceCategoriesView = Atom.family((client: FidyClient) =>
  workspaceCategoriesSource(client).pipe(revalidateWorkspaceQuery)
);
export const workspaceCategoriesQuery = (
  client: FidyClient
): Readonly<{
  source: CategoriesQuery;
  view: CategoriesQuery;
}> => ({ source: workspaceCategoriesSource(client), view: workspaceCategoriesView(client) });
export const workspaceDashboardCatalogQuery: (client: FidyClient) => CatalogQuery = Atom.family(
  (client: FidyClient) =>
    client
      .query("dashboard", "listDashboardCatalog", workspaceQueryRetention)
      .pipe(revalidateWorkspaceQuery)
);
