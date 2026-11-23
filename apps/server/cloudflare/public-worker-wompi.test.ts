import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { makePublicWorker } from "./public-worker";
import { makeWorkerTelemetry } from "./runtime/telemetry/operations";

const path = "/providers/wompi/billing-events";

const workerEnvironment = (
  receive: (headers: Headers) => void
): Parameters<ReturnType<typeof makePublicWorker>["fetch"]>[1] => ({
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  LOCAL_CANONICAL_READ_BEARER: "",
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: "e".repeat(40),
  CORE: {
    fetch: (input) => {
      receive(new Request(input).headers);

      return Promise.resolve(new Response(null, { status: 204 }));
    },
  },
});

it("forwards the Wompi checksum header only when the provider sent it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reachedCore = false;
      let forwarded = new Headers();
      const worker = makePublicWorker(makeWorkerTelemetry(() => undefined));

      const environment = workerEnvironment((headers) => {
        reachedCore = true;
        forwarded = headers;
      });

      yield* Effect.tryPromise(() =>
        worker.fetch(
          new Request(`https://api.fidyapp.com${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          environment
        )
      );

      expect(reachedCore).toBe(true);
      expect(forwarded.has("x-event-checksum")).toBe(false);

      yield* Effect.tryPromise(() =>
        worker.fetch(
          new Request(`https://api.fidyapp.com${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-event-checksum": "a".repeat(64) },
            body: "{}",
          }),
          environment
        )
      );

      expect(forwarded.get("x-event-checksum")).toBe("a".repeat(64));
    })
  ));
