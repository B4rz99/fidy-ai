import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Ref } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { expectNotInspected } from "~/shell/testing/credential-failure";
import { authenticatedRunnerMiddleware } from "./authenticated-cluster-http";

const tokenFixture = "f1d7c0de".repeat(8);
const token = Redacted.make(tokenFixture);
type RunnerHandler = (request: Request) => Promise<Response>;
const post = (
  handler: RunnerHandler,
  headers: Readonly<Record<string, string>> = {}
): Effect.Effect<Response> =>
  Effect.promise(() =>
    handler(new Request("http://runner/_fidy/cluster", { method: "POST", headers }))
  );
const get = (handler: RunnerHandler, path: string): Effect.Effect<Response> =>
  Effect.promise(() => handler(new Request(`http://runner${path}`)));
const releaseHandler = (dispose: () => Promise<void>): Effect.Effect<void> =>
  Effect.promise(dispose);
const responseText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text());

it.effect("keeps Cluster credentials out of authentication failures", () =>
  Effect.gen(function* () {
    const invocations = yield* Ref.make(0);
    const routes = HttpRouter.use((router) =>
      router.add(
        "POST",
        "/_fidy/cluster",
        Ref.update(invocations, (count) => count + 1).pipe(
          Effect.as(HttpServerResponse.text("accepted"))
        )
      )
    );

    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(Layer.mergeAll(authenticatedRunnerMiddleware(token), routes), {
          disableLogger: true,
        })
      ),
      ({ handler }) =>
        Effect.gen(function* () {
          const missing = yield* post(handler);
          const malformed = yield* post(handler, { authorization: Redacted.value(token) });
          const incorrect = yield* post(handler, {
            authorization: `Bearer ${"b".repeat(64)}`,
          });

          expect(missing.status).toBe(401);
          expect(malformed.status).toBe(401);
          expect(incorrect.status).toBe(401);
          expect(yield* responseText(missing)).toBe("");
          expect(yield* responseText(malformed)).toBe("");
          expect(yield* responseText(incorrect)).toBe("");
          expect(yield* Ref.get(invocations)).toBe(0);

          expectNotInspected(token, tokenFixture);
          expectNotInspected(authenticatedRunnerMiddleware(token), tokenFixture);

          const accepted = yield* post(handler, {
            authorization: `Bearer ${Redacted.value(token)}`,
          });
          expect(accepted.status).toBe(200);
          expect(yield* responseText(accepted)).toBe("accepted");
          expect(yield* Ref.get(invocations)).toBe(1);

          const publicResponse = yield* get(handler, "/health");
          expect(publicResponse.status).toBe(404);
        }),
      ({ dispose }) => releaseHandler(dispose)
    );
  })
);
