import { Option } from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import type { FidyClient } from "@/transport/client";
import { type Snapshot, initialSnapshot } from "./model";
import { dashboardQuery } from "./query";

type Configuration = Readonly<{
  client: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  changed: (snapshot: Snapshot) => void;
}>;
const status = (state: CanonicalQueryState<unknown, unknown>): Snapshot["status"] => {
  if (state._tag === "Ready") return "Ready";
  return state._tag === "Failure" ? "Failed" : "Loading";
};
const failed = (state: CanonicalQueryState<unknown, unknown>): boolean =>
  state._tag === "Failure" || (state._tag === "Ready" && Option.isSome(state.refreshFailure));
/** Owns independent Dashboard and catalog subscriptions in one authentication registry. */
export const makeDashboardQueryOwner = ({
  client,
  registry,
  changed,
}: Configuration): Readonly<{
  dispose: () => void;
  refresh: () => void;
  refreshCatalog: () => void;
}> => {
  const dashboard = dashboardQuery(client);
  const catalog = client.query("dashboard", "listDashboardCatalog", {});
  let active = true;
  const publish = (): void => {
    if (!active) return;
    const view = presentCanonicalQuery(registry.get(dashboard.result));
    const entries = presentCanonicalQuery(registry.get(catalog));
    changed({
      ...initialSnapshot,
      view: view._tag === "Ready" ? Option.some(view.value.data) : Option.none(),
      catalog: entries._tag === "Ready" ? entries.value.data : [],
      status: status(view),
      waiting: view.waiting,
      stale: view._tag === "Ready" && Option.isSome(view.refreshFailure),
      boundaryFailure: view._tag === "Failure" && view.failure._tag !== "DeclaredFailure",
      catalogWaiting: entries.waiting,
      catalogFailed: failed(entries),
      phase: registry.get(dashboard.phase),
    });
  };
  // Phase changes can occur during the result atom's initialization. Observe after that
  // evaluation completes so a synchronous phase subscriber cannot start a second read.
  let scheduled = false;
  const schedule = (): void => {
    if (!active || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      publish();
    });
  };
  const releases = [
    registry.subscribe(dashboard.result, schedule),
    registry.subscribe(dashboard.phase, schedule),
    registry.subscribe(catalog, schedule),
  ];
  schedule();
  return {
    dispose: (): void => {
      active = false;
      for (const release of releases) release();
    },
    refresh: (): void => registry.refresh(dashboard.result),
    refreshCatalog: (): void => registry.refresh(catalog),
  };
};
