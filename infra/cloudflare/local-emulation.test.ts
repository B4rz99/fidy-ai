import { BunServices } from "@effect/platform-bun";
import { categoryRows } from "@fidy/server/categories";
import { FidyApi, TokenBearer, makeTokenAuthorizationClientLive } from "@fidy/server/client";
import { layer } from "@effect/vitest";
import { Data, Effect, Layer, Schedule } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { HttpApiClient } from "effect/unstable/httpapi";
import { ChildProcess } from "effect/unstable/process";
import { expect } from "vitest";
import { localCanonicalReadBearer } from "./topology";

const infrastructureRoot = new URL(".", import.meta.url).pathname;
const ingressOrigin = "http://127.0.0.1:8787";
const webOrigin = "http://127.0.0.1:5173";
const HTTP_OK = 200;

class UnexpectedHttpStatus extends Data.TaggedError("UnexpectedHttpStatus")<{
  readonly actual: number;
  readonly url: string;
}> {}

const fetchWhenReady = (
  url: string
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError | UnexpectedHttpStatus,
  HttpClient.HttpClient
> =>
  HttpClient.get(url).pipe(
    Effect.filterOrFail(
      (response) => response.status === HTTP_OK,
      (response) => new UnexpectedHttpStatus({ actual: response.status, url })
    ),
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 })
  );

const LocalEmulationServices = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);

layer(LocalEmulationServices, {
  excludeTestServices: true,
  timeout: "30 seconds",
})("Alchemy local emulation", (it) => {
  it.effect(
    "serves the browser through the real ingress-to-Core service binding",
    () =>
      Effect.gen(function* () {
        const developmentProcess = yield* ChildProcess.make("bun", ["run", "dev"], {
          cwd: infrastructureRoot,
          stderr: "ignore",
          stdin: "ignore",
          stdout: "ignore",
        });
        yield* Effect.addFinalizer(() =>
          developmentProcess.kill({ killSignal: "SIGINT" }).pipe(Effect.ignore)
        );

        const healthResponse = yield* fetchWhenReady(`${ingressOrigin}/health`);
        expect(yield* healthResponse.json).toEqual({
          contractDigest: "0000000000000000000000000000000000000000000000000000000000000000",
          gitRevision: "0000000000000000000000000000000000000000",
          status: "available",
        });

        const canonicalClient = yield* HttpApiClient.make(FidyApi, {
          baseUrl: ingressOrigin,
        }).pipe(
          // This integration-test boundary owns the generated client's authorization layer.
          // @effect-diagnostics-next-line strictEffectProvide:off
          Effect.provide(
            makeTokenAuthorizationClientLive(TokenBearer.make(localCanonicalReadBearer))
          )
        );
        const categoriesResponse = yield* canonicalClient.categories.listCategories();
        expect(categoriesResponse).toEqual({
          data: categoryRows.map(({ id, label }) => ({ id, label })),
          next: [],
        });

        const browserModule = yield* fetchWhenReady(`${webOrigin}/src/app/application.tsx`);
        expect(yield* browserModule.text).toContain(ingressOrigin);
      }),
    30_000
  );
});
