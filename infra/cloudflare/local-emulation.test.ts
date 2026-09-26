import { BunServices } from "@effect/platform-bun";
import { layer } from "@effect/vitest";
import { Data, Effect, Layer, Schedule } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ChildProcess } from "effect/unstable/process";
import { expect } from "vitest";
import { localCanonicalReadBearer } from "../../apps/server/cloudflare/runtime/topology";

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
          env: { ...Bun.env, CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000" },
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

        // This local fixture is not a persisted PAT; Core must reject it rather than bypassing auth.
        const categoriesResponse = yield* HttpClient.get(`${ingressOrigin}/categories`, {
          headers: { authorization: `Bearer ${localCanonicalReadBearer}` },
        });
        expect(categoriesResponse.status).toBe(401);
        expect(yield* categoriesResponse.json).toEqual({
          error: { code: "unauthenticated", message: "Present a valid credential and retry." },
          next: [],
        });

        const browserModule = yield* fetchWhenReady(`${webOrigin}/src/app/application.tsx`);
        expect(yield* browserModule.text).toContain(ingressOrigin);
      }),
    30_000
  );
});
