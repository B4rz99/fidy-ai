import * as Alchemist from "alchemy/Alchemist";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { nativeResourceInventory } from "./native-graph";
import { type NativeStageFailure, nativeResourceStage } from "./resource-failure";

const phases = new Set<Alchemist.PlanningPhase>([
  "importing-module",
  "resolving-services",
  "loading-state",
  "computing-plan",
  "plan-ready",
]);
const readClasses: ReadonlyArray<readonly [RegExp, string]> = [
  [/^access\/identity_providers(?:\/|$)/u, "Access identity providers"],
  [/^access\/groups(?:\/|$)/u, "Access groups"],
  [/^access\/apps(?:\/|$)/u, "Access applications"],
  [/^queues(?:\/|$)/u, "queues"],
  [/^r2\/buckets(?:\/|$)/u, "R2 buckets"],
  [/^workflows(?:\/|$)/u, "Workflows"],
  [/^workers\/scripts(?:\/|$)/u, "Worker scripts"],
  [/^workers\/domains(?:\/|$)/u, "Worker domains"],
];
const stateReads: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/version$/u, "state version"],
  [/^\/state\/stacks$/u, "state authentication"],
  [/\/resources\/[^/]+$/u, "state resource"],
  [/\/resources$/u, "state inventory"],
];
const matchRead = (classes: typeof readClasses, path: string): Option.Option<string> =>
  Option.fromUndefinedOr(classes.find(([pattern]) => pattern.test(path))?.[1]);
const readClass = (url: URL): Option.Option<string> => {
  if (/^alchemy-state-store\.[^.]+\.workers\.dev$/u.test(url.hostname)) {
    return matchRead(stateReads, url.pathname);
  }
  if (url.origin !== "https://api.cloudflare.com") return Option.none();
  return matchRead(readClasses, url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+\//u, ""));
};

const maximumReadOutcomes = 32;
// FetchHttpClient passes an absolute URL and a method. Preserve the request and response,
// collecting only the reviewed operation class and status.
const observeReads = (fetch: typeof globalThis.fetch, reads: Set<string>): typeof fetch => {
  const record = (kind: string, outcome: string): void => {
    if (reads.size < maximumReadOutcomes) reads.add(kind + " " + outcome);
  };
  return Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      if (init?.method !== "GET" || !(input instanceof URL)) return fetch(...args);
      const kind = readClass(input);
      if (Option.isNone(kind)) return fetch(...args);
      return fetch(...args).then(
        (response) => {
          record(kind.value, String(response.status));
          return response;
        },
        (error: unknown) => {
          record(kind.value, "transport failure");
          throw error;
        }
      );
    },
    { preconnect: fetch.preconnect }
  );
};

export const diagnoseNativePlan =
  (revision: string) =>
  <A, E, R>(plan: Effect.Effect<A, E, R>): Effect.Effect<A, E | NativeStageFailure, R> =>
    Effect.gen(function* () {
      const report = yield* Alchemist.Progress;

      const pending = new Set<string>();
      const reads = new Set<string>();
      const inventory = nativeResourceInventory(revision);
      let phase = "starting",
        started = 0,
        completed = 0;
      const observe: Alchemist.ProgressReporter = (event) =>
        Effect.sync(() => {
          if (event._tag === "plan.phase" && phases.has(event.phase)) phase = event.phase;
          if (event._tag !== "plan.resource.started" && event._tag !== "plan.resource.completed") {
            return;
          }
          if (event._tag === "plan.resource.started") started++;
          else completed++;
          if (inventory.get(event.logicalId) !== event.resourceType) return;
          const label = event.logicalId.replace(/-[a-f0-9]{40}$/u, "");
          if (event._tag === "plan.resource.started") pending.add(label);
          else pending.delete(label);
        }).pipe(Effect.andThen(report(event)));

      const diagnostics = (): string =>
        " Planner phase " +
        phase +
        ". Resource diffs completed " +
        completed +
        "/" +
        started +
        ". Unfinished resources [" +
        [...pending].sort().join(", ") +
        "]. Observed reads [" +
        [...reads].sort().join(", ") +
        "].";
      return yield* plan.pipe(
        Effect.provideService(Alchemist.Progress, observe),
        Effect.updateService(FetchHttpClient.Fetch, (fetch) => observeReads(fetch, reads)),
        nativeResourceStage({ stage: "planning", details: diagnostics })
      );
    });
