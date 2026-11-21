import { requireStagedDestinations } from "./native-host-plan";

import { Effect, Result, type Schema } from "effect";
import { expect, it } from "vitest";
import { verifyIncumbentFence, verifyIncumbentMail } from "./native-incumbent-fence";

const core = "fidycloudflare-core-123";

const oldQueue = "fidycloudflare-asyncdeadletters-123";

type ProviderEnvelope = Readonly<{ success: true; result: Schema.Json }>;

const ok = (result: Schema.Json): ProviderEnvelope => ({ success: true, result });

const inventory = (path: string): Schema.Json => {
  const url = new URL(path, "https://provider.invalid");

  if (url.pathname === "/workers/scripts") {
    return ok([{ id: core }, { id: "fidy-web" }, { id: "fidy-native-storage-core" }]);
  }

  if (url.pathname.endsWith("/schedules")) return ok({ schedules: [] });

  if (url.pathname.endsWith("/subdomain")) return ok({ enabled: false, previews_enabled: false });

  if (url.pathname === "/queues") {
    return ok([
      { queue_id: "original-dlq", queue_name: oldQueue, settings: { delivery_paused: true } },
    ]);
  }

  if (url.pathname === "/workflows") return ok([{ name: "old-billing", script_name: core }]);

  if (
    url.pathname === "/workflows/old-billing/instances" &&
    url.searchParams.get("per_page") === "1"
  ) {
    return ok([]);
  }

  throw Error("Unexpected inventory");
};

const fenceRefuses = Effect.fnUntraced(function* (fragment: string, replacement: Schema.Json) {
  const verdict = yield* Effect.result(
    verifyIncumbentFence((path) =>
      Effect.try(() => (path.includes(fragment) ? replacement : inventory(path)))
    )
  );

  return Result.isFailure(verdict);
});

it("requires fenced incumbent queues including the retained DLQ, stable Workers and quiescent Workflows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const baseline = yield* verifyIncumbentFence((path) => Effect.try(() => inventory(path)));
      expect(baseline.pausedQueues).toEqual([{ id: "original-dlq", name: oldQueue }]);

      yield* Effect.forEach(
        [
          ["schedules", ok({ schedules: [{ cron: "* * * * *" }] })],
          ["subdomain", ok({ enabled: false, previews_enabled: true })],
          ["queues", ok([{ queue_id: "original-dlq", queue_name: oldQueue, settings: {} }])],
          ["queues", ok([])],
          ["status=waiting", ok([{ id: "live-job" }])],
          ["workflows?", { success: false }],
        ] as const,
        Effect.fnUntraced(function* ([fragment, replacement]) {
          expect(yield* fenceRefuses(fragment, replacement)).toBe(true);
        }),
        { discard: true }
      );
    })
  ));

it("checks regular and catch-all email routing, including account-level rules, before staging", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const disabled = { enabled: false, actions: [{ type: "worker", value: [core] }] };
      const enabled = { ...disabled, enabled: true };

      const verify = (scope: string): ReturnType<typeof verifyIncumbentMail> =>
        verifyIncumbentMail(
          () => Effect.succeed(ok([scope === "account" ? enabled : disabled])),
          (path) =>
            Effect.succeed(
              ok(
                path.endsWith("catch_all")
                  ? { ...disabled, enabled: scope === "catch" }
                  : [scope === "zone" ? enabled : disabled]
              )
            )
        );

      yield* verify("off");

      yield* Effect.forEach(
        ["account", "zone", "catch"],
        Effect.fnUntraced(function* (scope) {
          expect(Result.isFailure(yield* Effect.result(verify(scope)))).toBe(true);
        }),
        { discard: true }
      );
    })
  ));

it.each([
  ["IngestSampleReviewAccess", "/internal/sample-review"],
  ["BetaProAccess", "/internal/beta-pro"],
])("limits %s to adding its canonical API path with the same policy", (logicalId, path) => {
  const initial = {
    destinations: [{ type: "public", uri: "storage-acceptance.fidyapp.com" + path }],
    policies: [{ decision: "allow", include: [{ email: "assigned@example.test" }] }],
  };

  const staged = {
    ...initial,
    destinations: [...initial.destinations, { type: "public", uri: "api.fidyapp.com" + path }],
  };

  expect(() =>
    requireStagedDestinations({
      logicalId,
      before: initial,
      after: staged,
    })
  ).not.toThrow();
  expect(() =>
    requireStagedDestinations({
      logicalId,
      before: staged,
      after: staged,
    })
  ).not.toThrow();
  expect(() =>
    requireStagedDestinations({
      logicalId,
      before: initial,
      after: { ...staged, policies: [] },
    })
  ).toThrow();
  expect(() =>
    requireStagedDestinations({
      logicalId,
      before: initial,
      after: {
        ...staged,
        destinations: staged.destinations.slice(1),
      },
    })
  ).toThrow();
});
