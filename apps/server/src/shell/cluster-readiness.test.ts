import { expect, it, layer } from "@effect/vitest";
import { Clock, Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";
import { ApiHarnessWithoutClusterRunner } from "~/shell/testing/api-harness";
import {
  ClusterReadiness,
  ClusterReadinessVolatile,
  cacheReadinessProbe,
  runReadinessAbility,
} from "./cluster-readiness";

layer(ApiHarnessWithoutClusterRunner, { excludeTestServices: true })(
  "public degraded Cluster readiness",
  (it) => {
    it.effect("returns bounded 503 responses when the listener has no Cluster runner", () =>
      Effect.gen(function* () {
        const responses = yield* Effect.all([
          HttpClient.get("/ready"),
          HttpClient.get("/ready"),
          HttpClient.get("/ready"),
        ]);

        for (const response of responses) {
          expect(response.status).toBe(503);
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(yield* response.json).toEqual({
            status: "unready",
            checks: { runnerState: false, routing: false, messageStorage: true },
          });
        }

        // The private runner route is absent from the real public application router even when a
        // caller presents a credential-shaped value.
        const privateRoute = yield* HttpClient.get("/_fidy/cluster", {
          headers: { authorization: `Bearer ${"f".repeat(64)}` },
        });
        expect(privateRoute.status).toBe(404);
      })
    );
  }
);

it.effect("shares one readiness execution across a burst and refreshes once after the TTL", () =>
  Effect.gen(function* () {
    const invocations = yield* Ref.make(0);
    const ability = Ref.update(invocations, (count) => count + 1).pipe(Effect.as(true));
    const probe = yield* cacheReadinessProbe({
      runnerState: ability,
      routing: ability,
      messageStorage: ability,
    });

    yield* Effect.all(
      Array.from({ length: 50 }, () => probe),
      { concurrency: "unbounded" }
    );
    yield* probe;
    expect(yield* Ref.get(invocations)).toBe(3);

    yield* TestClock.adjust("2001 millis");
    yield* Effect.all(
      Array.from({ length: 50 }, () => probe),
      { concurrency: "unbounded" }
    );
    expect(yield* Ref.get(invocations)).toBe(6);
  })
);

it.live("bounds and cancels a stalled readiness ability", () =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    expect(yield* runReadinessAbility(Option.some(Effect.never))).toBe(false);
    expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(2_500);
  })
);

layer(ClusterReadinessVolatile)("volatile Cluster readiness", (it) => {
  it.effect("volatile readiness reports every ability without durable Cluster state", () =>
    Effect.gen(function* () {
      const readiness = yield* ClusterReadiness;
      expect(yield* readiness.probe).toEqual({
        runnerState: true,
        routing: true,
        messageStorage: true,
      });
    })
  );
});
