import * as Alchemist from "alchemy/Alchemist";
import { Effect, Match, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { nativeResourceInventory } from "./native-graph";
import { type NativeStageFailure, nativeResourceStage } from "./resource-failure";
import { installationNames } from "./storage-installation";

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
  [/^builds\/workers\/[^/]+\/triggers$/u, "Worker Build triggers"],
  [/^workers\/durable_objects\/namespaces(?:\/|$)/u, "Durable Object namespaces"],
  [/^workers\/routes(?:\/|$)/u, "Worker routes"],
  [/^dns_records(?:\/|$)/u, "DNS records"],
  [/^rulesets(?:\/|$)/u, "firewall rules"],
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

  if (
    url.origin === "https://api.github.com" &&
    /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/trunk$/u.test(url.pathname)
  ) {
    return Option.some("trunk revision");
  }

  if (url.origin !== "https://api.cloudflare.com") return Option.none();

  if (url.pathname === "/client/v4/zones") return Option.some("zone authority");

  return matchRead(
    readClasses,
    url.pathname.replace(/^\/client\/v4\/(?:accounts|zones)\/[^/]+\//u, "")
  );
};

const maximumOutcomes = 32;

const observeHttp = ({
  fetch,
  outcomes,
  classify,
}: {
  fetch: typeof globalThis.fetch;
  outcomes: Set<string>;
  classify: (url: URL, method: string) => Option.Option<string>;
}): typeof fetch => {
  const record = (kind: string, outcome: string): void => {
    if (outcomes.size < maximumOutcomes) outcomes.add(kind + " " + outcome);
  };

  return Object.assign(
    (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;

      if (init?.method === undefined || !Schema.is(Schema.URL)(input)) return fetch(...args);
      const kind = classify(input, init.method);

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

const observeReads = (fetch: typeof globalThis.fetch, reads: Set<string>): typeof fetch =>
  observeHttp({
    fetch,
    outcomes: reads,
    classify: (url, method) => (method === "GET" ? readClass(url) : Option.none()),
  });

export const diagnoseSuccessorApply =
  (revision: string) =>
  <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | NativeStageFailure, R> =>
    Effect.suspend(() => {
      const writes = new Set<string>();
      const smoke = "fidy-native-smoke-" + revision;

      const endpoints = new Map([
        ["POST workers/scripts/" + installationNames.Core + "/versions", "Core version"],
        ["POST workers/scripts/" + installationNames.Ingress + "/versions", "Ingress version"],
        ["PUT workers/scripts/" + smoke, "Smoke Worker"],
        ["PUT workflows/" + smoke, "Smoke Workflow"],
        ["POST queues", "Smoke Queue"],
      ]);

      const classify = (url: URL, method: string): Option.Option<string> => {
        if (url.origin !== "https://api.cloudflare.com") return Option.none();
        const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+\//u, "");

        if (method === "POST" && /^queues\/[^/]+\/consumers$/u.test(path)) {
          return Option.some("Smoke Queue consumer");
        }

        return Option.fromUndefinedOr(endpoints.get(method + " " + path));
      };

      return operation.pipe(
        Effect.updateService(FetchHttpClient.Fetch, (fetch) =>
          observeHttp({ fetch, outcomes: writes, classify })
        ),
        nativeResourceStage({
          stage: "provider apply",
          details: () => " Observed writes [" + [...writes].join(", ") + "].",
        })
      );
    });

export const diagnoseFreshTarget = <A, E, R>(
  operation: Effect.Effect<A, E, R>
): Effect.Effect<A, E | NativeStageFailure, R> =>
  Effect.suspend(() => {
    const reads = new Set<string>();

    return operation.pipe(
      Effect.updateService(FetchHttpClient.Fetch, (fetch) => observeReads(fetch, reads)),
      nativeResourceStage({
        stage: "closed edge preparation",
        details: () => " Observed reads [" + [...reads].join(", ") + "].",
      })
    );
  });

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

      const tracked = (logicalId: string, resourceType: string): Option.Option<string> =>
        inventory.get(logicalId) === resourceType
          ? Option.some(logicalId.replace(/-[a-f0-9]{40}$/u, ""))
          : Option.none();

      const observe: Alchemist.ProgressReporter = (event) =>
        Effect.sync(() =>
          Match.value(event).pipe(
            Match.tag("plan.phase", ({ phase: next }) => {
              if (phases.has(next)) phase = next;
            }),
            Match.tag("plan.resource.started", ({ logicalId, resourceType }) => {
              started++;
              const label = tracked(logicalId, resourceType);

              if (Option.isSome(label)) pending.add(label.value);
            }),
            Match.tag("plan.resource.completed", ({ logicalId, resourceType }) => {
              completed++;
              const label = tracked(logicalId, resourceType);

              if (Option.isSome(label)) pending.delete(label.value);
            }),
            Match.orElse(() => undefined)
          )
        ).pipe(Effect.andThen(report(event)));

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
