import * as Alchemist from "alchemy/Alchemist";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { diagnoseNativePlan } from "./native-plan-diagnostics";
import { nativeResourceFailureMessage } from "./resource-failure";

const revision = "1".repeat(40);
const start = (
  report: Alchemist.ProgressReporter,
  logicalId: string,
  resourceType: string
): Effect.Effect<void> =>
  report({ _tag: "plan.resource.started", fqn: "private-fqn", logicalId, resourceType, total: 2 });

it.effect("forwards the successful plan and progress", () =>
  Effect.gen(function* () {
    const phases: string[] = [];
    const result = yield* Effect.gen(function* () {
      const report = yield* Alchemist.Progress;
      yield* report({ _tag: "plan.phase", phase: "computing-plan" });
      return "verified";
    }).pipe(
      diagnoseNativePlan(revision),
      Effect.provideService(Alchemist.Progress, (event) =>
        Effect.sync(() => {
          phases.push(event._tag);
        })
      )
    );
    expect(result).toBe("verified");
    expect(phases).toEqual(["plan.phase"]);
  })
);

it.effect.each([
  { error: { _tag: "Forbidden", code: 10001 }, category: "Forbidden; code=10001" },
  {
    error: { _tag: "StateStoreError", http: { status: 403 } },
    category: "StateStoreError; HTTP 403",
  },
  { error: { _tag: "OwnedBySomeoneElse" }, category: "OwnedBySomeoneElse" },
  {
    error: { _tag: "CloudflareParseError", body: "private-body" },
    category: "CloudflareParseError",
  },
  { error: Error("private-message"), category: "Error" },
])("reports only the reviewed evidence for $category", ({ error, category }) =>
  Effect.gen(function* () {
    const fixtureFetch = Object.assign(
      () => Promise.resolve(new Response("private-body", { status: 403 })),
      {
        preconnect: fetch.preconnect,
      }
    );
    const failure = yield* Effect.gen(function* () {
      const report = yield* Alchemist.Progress;
      yield* report({ _tag: "plan.phase", phase: "computing-plan" });
      yield* start(report, "ReleaseSmokeQueue-" + revision, "Cloudflare.Queues.Queue");
      yield* start(report, "private-resource", "private-type");
      yield* start(report, "ForwardedEmail", "Cloudflare.Worker");
      yield* report({
        _tag: "plan.resource.completed",
        fqn: "private-fqn",
        logicalId: "ForwardedEmail",
        resourceType: "Cloudflare.Worker",
        action: "create",
        bindings: [],
        completed: 1,
        total: 3,
      });
      yield* HttpClient.get(
        "https://api.cloudflare.com/client/v4/accounts/private/queues?secret=private"
      );
      yield* HttpClient.get(
        "https://alchemy-state-store.private.workers.dev/state/stacks/private/stages/private/resources/private"
      );
      return yield* Effect.fail(error);
    }).pipe(
      diagnoseNativePlan(revision),
      Effect.provideService(FetchHttpClient.Fetch, fixtureFetch),
      Effect.provide(FetchHttpClient.layer),
      Effect.matchCause({
        onFailure: nativeResourceFailureMessage,
        onSuccess: () => "unexpected success",
      })
    );
    expect(failure).toContain("(" + category + ")");
    expect(failure).toContain(
      "Planner phase computing-plan. Resource diffs completed 1/3. Unfinished resources [ReleaseSmokeQueue]. Observed reads [queues 403, state resource 403]."
    );
    expect(failure).not.toContain("private");
    expect(failure).not.toContain(revision);
  })
);
