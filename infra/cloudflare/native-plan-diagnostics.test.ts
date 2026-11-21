import * as Alchemist from "alchemy/Alchemist";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { it, layer } from "@effect/vitest";
import { expect } from "vitest";
import {
  diagnoseFreshTarget,
  diagnoseNativePlan,
  diagnoseSuccessorApply,
} from "./native-plan-diagnostics";
import { nativeResourceFailureMessage } from "./resource-failure";

const Forbidden = Schema.TaggedStruct("Forbidden", { code: Schema.Finite });

const StateStoreError = Schema.TaggedStruct("StateStoreError", {
  http: Schema.Struct({ status: Schema.Finite }),
});

const OwnedBySomeoneElse = Schema.TaggedStruct("OwnedBySomeoneElse", {});

const CloudflareParseError = Schema.TaggedStruct("CloudflareParseError", { body: Schema.String });

const PlanPhaseChanged = Schema.TaggedStruct("plan.phase", {
  phase: Schema.Literal("computing-plan"),
});

const ResourceDiffStarted = Schema.TaggedStruct("plan.resource.started", {
  fqn: Schema.String,
  logicalId: Schema.String,
  resourceType: Schema.String,
  total: Schema.Finite,
});

const ResourcePlanned = Schema.TaggedStruct("plan.resource.completed", {
  fqn: Schema.String,
  logicalId: Schema.String,
  resourceType: Schema.String,
  action: Schema.Literal("create"),
  bindings: Schema.Array(Schema.Never),
  completed: Schema.Finite,
  total: Schema.Finite,
});

const revision = "1".repeat(40);

const start = (
  report: Alchemist.ProgressReporter,
  logicalId: string,
  resourceType: string
): Effect.Effect<void> =>
  report(ResourceDiffStarted.make({ fqn: "private-fqn", logicalId, resourceType, total: 2 }));

it.effect("forwards the successful plan and progress", () =>
  Effect.gen(function* () {
    const phases: string[] = [];

    const result = yield* Effect.gen(function* () {
      const report = yield* Alchemist.Progress;
      yield* report(PlanPhaseChanged.make({ phase: "computing-plan" }));

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

layer(FetchHttpClient.layer)("native planner HTTP reads", (suite) => {
  suite.effect.each([
    { error: Forbidden.make({ code: 10001 }), category: "Forbidden; code=10001" },
    {
      error: StateStoreError.make({ http: { status: 403 } }),
      category: "StateStoreError; HTTP 403",
    },
    { error: OwnedBySomeoneElse.make({}), category: "OwnedBySomeoneElse" },
    {
      error: CloudflareParseError.make({ body: "private-body" }),
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
        yield* report(PlanPhaseChanged.make({ phase: "computing-plan" }));
        yield* start(report, "ReleaseSmokeQueue-" + revision, "Cloudflare.Queues.Queue");
        yield* start(report, "private-resource", "private-type");
        yield* start(report, "ForwardedEmail", "Cloudflare.Worker");
        yield* report(
          ResourcePlanned.make({
            fqn: "private-fqn",
            logicalId: "ForwardedEmail",
            resourceType: "Cloudflare.Worker",
            action: "create",
            bindings: [],
            completed: 1,
            total: 3,
          })
        );
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
});

layer(FetchHttpClient.layer)("closed installation target", (suite) => {
  suite.effect(
    "attributes a refused read to its endpoint family without disclosing identifiers",
    () =>
      Effect.gen(function* () {
        const request = HttpClient.get(
          "https://api.cloudflare.com/client/v4/accounts/private/builds/workers/private/triggers"
        ).pipe(Effect.andThen(Effect.fail(Error("private-provider-message"))));

        const failure = yield* request.pipe(
          diagnoseFreshTarget,
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              () => Promise.resolve(new Response("private-response", { status: 403 })),
              { preconnect: fetch.preconnect }
            )
          ),
          Effect.matchCause({ onFailure: nativeResourceFailureMessage, onSuccess: () => "" })
        );

        expect(failure).toContain("Worker Build triggers 403");
        expect(failure).not.toContain("private");
      })
  );
});

layer(FetchHttpClient.layer)("scoped successor upload", (suite) => {
  suite.effect(
    "reports the exact Workflow and Ingress upload statuses without request details",
    () =>
      Effect.gen(function* () {
        const account = "https://api.cloudflare.com/client/v4/accounts/private-account";

        const failure = yield* Effect.gen(function* () {
          yield* HttpClient.post(account + "/workers/scripts/fidy-native-storage-ingress/versions");
          yield* HttpClient.put(
            account + "/workflows/fidy-native-smoke-" + revision + "?secret=private"
          );
          yield* HttpClient.put(account + "/workflows/private-unreviewed-name");

          return yield* Effect.fail(Error("private-provider-message"));
        }).pipe(
          diagnoseSuccessorApply(revision),
          Effect.provideService(
            FetchHttpClient.Fetch,
            Object.assign(
              (input: URL | Request | string) =>
                Promise.resolve(
                  new Response("private-response", {
                    status:
                      Schema.is(Schema.URL)(input) && input.pathname.includes("/workflows/")
                        ? 422
                        : 200,
                  })
                ),
              { preconnect: fetch.preconnect }
            )
          ),
          Effect.matchCause({ onFailure: nativeResourceFailureMessage, onSuccess: () => "" })
        );

        expect(failure).toContain("Observed writes [Ingress version 200, Smoke Workflow 422].");
        expect(failure).not.toContain("private");
        expect(failure).not.toContain(revision);
      })
  );
});
