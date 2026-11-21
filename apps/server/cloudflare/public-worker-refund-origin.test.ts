import { expect, it } from "vitest";
import { Effect } from "effect";
import { makePublicWorker } from "./public-worker";
import { makeWorkerTelemetry } from "./runtime/telemetry/operations";

const origin = "https://app.fidyapp.com";
const refusedStatus = 403;
const cases = [
  { path: "/internal/support/billing-refunds", method: "POST" },
  {
    path: "/internal/support/billing-refunds/10000000-0000-4000-8000-000000000051/10000000-0000-4000-8000-000000000052",
    method: "GET",
  },
];

it.each(cases)(
  "refuses the first-party browser Origin on the refund support path $path",
  ({ path, method }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let reachedCore = false;
        const response = yield* Effect.tryPromise(() =>
          makePublicWorker(makeWorkerTelemetry(() => undefined)).fetch(
            new Request(`https://api.fidyapp.com${path}`, {
              method,
              headers: {
                "content-type": "application/json",
                "cf-access-jwt-assertion": "untrusted",
                origin,
              },
            }),
            {
              BROWSER_ORIGIN: origin,
              LOCAL_CANONICAL_READ_BEARER: "",
              PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
              RELEASE_GIT_SHA: "c".repeat(40),
              CORE: {
                fetch: () => {
                  reachedCore = true;
                  return Promise.resolve(new Response(null, { status: refusedStatus }));
                },
              },
            }
          )
        );
        expect(reachedCore).toBe(false);
        expect(response.status).toBe(refusedStatus);
      })
    )
);
