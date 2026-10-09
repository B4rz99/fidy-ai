import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy/Resource";
import { evalStack } from "alchemy/Stack";
import { InMemoryService, State } from "alchemy/State";
import { it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Data, Effect, Exit, FileSystem, Layer } from "effect";
import { afterAll, beforeAll, expect, vi } from "vitest";

let profileDirectory = "";
beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      profileDirectory = yield* (yield* FileSystem.FileSystem).makeTempDirectory({
        prefix: "retirement-",
      });
      vi.stubEnv("ALCHEMY_HOME", profileDirectory);
    }).pipe(Effect.provide(BunServices.layer))
  )
);
afterAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.unstubAllEnvs();
      if (profileDirectory !== "") {
        yield* (yield* FileSystem.FileSystem).remove(profileDirectory, { recursive: true });
      }
    }).pipe(Effect.provide(BunServices.layer))
  )
);

type FixtureResource = Resource<
  "RetirementFixture.Resource",
  { revision: string; dependency: string; replacement: "update" | "create-first" | "delete-first" },
  { identity: string; revision: string; dependency: string }
>;
const FixtureResource = Resource<FixtureResource>("RetirementFixture.Resource");
class ResourceStillUsed extends Data.TaggedError("ResourceStillUsed")<{}> {}

const fixture = Effect.sync(() => {
  let refuseDeletion = false;
  const cloud = new Map<string, FixtureResource["Attributes"]>();
  const calls: string[] = [];
  const state = Layer.succeed(State, InMemoryService());
  const providers = Provider.succeed(FixtureResource, {
    diff: ({ olds, news }) =>
      Effect.succeed(
        isResolved(news) && olds.revision !== news.revision && news.replacement !== "update"
          ? { action: "replace" as const, deleteFirst: news.replacement === "delete-first" }
          : undefined
      ),
    read: ({ output }) => Effect.succeed(output && cloud.get(output.identity)),
    reconcile: ({ id, instanceId, news }) =>
      Effect.sync(() => {
        const result = { identity: `${id}:${instanceId}`, ...news };
        calls.push(`reconcile:${id}`);
        cloud.set(result.identity, result);
        return result;
      }),
    delete: ({ output }) =>
      Effect.gen(function* () {
        if (
          refuseDeletion ||
          [...cloud.values()].some((resource) => resource.dependency === output.identity)
        ) {
          return yield* new ResourceStillUsed();
        }
        calls.push("delete:" + output.identity.split(":")[0]);
        cloud.delete(output.identity);
      }),
  });
  const deploy = Effect.fn(function* (
    onboarding: boolean,
    revision: string,
    mode:
      | "defer"
      | "only"
      | { deletions: "defer" | "only"; replacement: "create-first" | "delete-first" }
  ) {
    const deletions = typeof mode === "string" ? mode : mode.deletions;
    const replacement = typeof mode === "string" ? "update" : mode.replacement;
    return yield* evalStack(
      Alchemy.Stack(
        "RetirementFixture",
        { providers, state },
        Effect.gen(function* () {
          const dependency = onboarding
            ? (yield* FixtureResource("OnboardingQueue", {
                revision: "1",
                dependency: "",
                replacement: "update",
              })).identity
            : "";
          return yield* FixtureResource("Core", { revision, dependency, replacement });
        })
      ),
      Effect.fn(function* (stack) {
        const plan = yield* Plan.make(stack);
        return yield* Apply.apply(plan, { deletions }).pipe(Effect.provide(stack.services));
      }),
      { stage: "production" }
    ).pipe(Effect.provide(state));
  });
  return {
    cloud,
    calls,
    deploy,
    refuseDeletion: (refuse: boolean): void => {
      refuseDeletion = refuse;
    },
  };
});

it.effect(
  "keeps the serving Core's Queue tracked through upload, then retires without redeploying",
  () =>
    Effect.gen(function* () {
      const { cloud, calls, deploy } = yield* fixture;
      yield* deploy(true, "1", "defer");
      const candidate = yield* deploy(false, "2", "defer");
      expect(
        [...cloud.values()].some((resource) => resource.identity.startsWith("OnboardingQueue:"))
      ).toBe(true);
      expect(calls).not.toContain("delete:OnboardingQueue");
      const beforeCleanup = calls.filter((call) => call.startsWith("reconcile:"));
      yield* deploy(false, "2", "only");
      expect(calls).toContain("delete:OnboardingQueue");
      expect(calls.filter((call) => call.startsWith("reconcile:"))).toEqual(beforeCleanup);
      expect([...cloud.values()]).toEqual([candidate]);
    }).pipe(Effect.provide(Alchemist.layer()))
);

it.effect(
  "preserves replaced generations until cleanup and deletes dependents before their Queue",
  () =>
    Effect.gen(function* () {
      const { cloud, calls, deploy } = yield* fixture;
      const baseline = yield* deploy(true, "1", "defer");
      const candidate = yield* deploy(false, "2", {
        deletions: "defer",
        replacement: "create-first",
      });
      expect(cloud.get(baseline.identity)).toEqual(baseline);
      expect(cloud.get(candidate.identity)).toEqual(candidate);
      expect(calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
      const beforeCleanup = calls.filter((call) => call.startsWith("reconcile:"));
      yield* deploy(false, "2", { deletions: "only", replacement: "create-first" });
      expect(calls.filter((call) => call.startsWith("delete:"))).toEqual([
        "delete:Core",
        "delete:OnboardingQueue",
      ]);
      expect(calls.filter((call) => call.startsWith("reconcile:"))).toEqual(beforeCleanup);
      expect([...cloud.values()]).toEqual([candidate]);
      yield* deploy(false, "2", { deletions: "only", replacement: "create-first" });
      expect(calls.filter((call) => call.startsWith("delete:"))).toHaveLength(2);
    }).pipe(Effect.provide(Alchemist.layer()))
);

it.effect("refuses delete-first replacement before any resource mutation", () =>
  Effect.gen(function* () {
    const { cloud, calls, deploy } = yield* fixture;
    yield* deploy(true, "1", "defer");
    const baseline = [...cloud.values()];
    const beforeUpload = [...calls];
    const upload = yield* Effect.exit(
      deploy(false, "2", { deletions: "defer", replacement: "delete-first" })
    );
    expect(Exit.isFailure(upload)).toBe(true);
    expect(calls).toEqual(beforeUpload);
    expect([...cloud.values()]).toEqual(baseline);
  }).pipe(Effect.provide(Alchemist.layer()))
);

it.effect("refuses cleanup when the desired Core differs from the verified upload", () =>
  Effect.gen(function* () {
    const { cloud, calls, deploy } = yield* fixture;
    yield* deploy(true, "1", "defer");
    yield* deploy(false, "2", "defer");
    const beforeCleanup = [...calls];
    const cleanup = yield* Effect.exit(deploy(false, "3", "only"));
    expect(Exit.isFailure(cleanup)).toBe(true);
    expect(calls).toEqual(beforeCleanup);
    expect(
      [...cloud.values()].some((resource) => resource.identity.startsWith("OnboardingQueue:"))
    ).toBe(true);
  }).pipe(Effect.provide(Alchemist.layer()))
);

it.effect(
  "keeps a failed deletion tracked and retries without reconciling the verified deployment",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture;
      yield* test.deploy(true, "1", "defer");
      const candidate = yield* test.deploy(false, "2", "defer");
      const beforeCleanup = [...test.calls];
      test.refuseDeletion(true);
      expect(Exit.isFailure(yield* Effect.exit(test.deploy(false, "2", "only")))).toBe(true);
      expect(test.calls).toEqual(beforeCleanup);
      expect([...test.cloud.values()]).toHaveLength(2);
      test.refuseDeletion(false);
      yield* test.deploy(false, "2", "only");
      expect([...test.cloud.values()]).toEqual([candidate]);
      expect(test.calls).toEqual([...beforeCleanup, "delete:OnboardingQueue"]);
    }).pipe(Effect.provide(Alchemist.layer()))
);
