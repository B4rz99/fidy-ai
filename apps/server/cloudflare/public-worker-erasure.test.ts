import { expect, it } from "vitest";
import { Effect } from "effect";
import { makePublicWorker } from "./public-worker";
import { makeWorkerTelemetry } from "./runtime/telemetry/operations";

const override = 'private-core="12740000-0000-4000-8000-000000000001"';
const refusedStatus = 403;
const cases = [
  { path: "/internal/titular-erasure", assertion: "", origin: "", forwarded: true },
  { path: "/internal/support-recovery", assertion: "untrusted", origin: "", forwarded: true },
  {
    path: "/categories",
    assertion: "untrusted",
    origin: "https://app.fidyapp.com",
    forwarded: true,
  },
  {
    path: "/internal/titular-erasure",
    assertion: "untrusted",
    origin: "https://app.fidyapp.com",
    forwarded: false,
  },
];

it.each(cases)(
  "does not lend candidate routing to $path with origin '$origin' and assertion '$assertion'",
  ({ path, assertion, origin, forwarded }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        let reachedCore = false;
        const response = yield* Effect.tryPromise(() =>
          makePublicWorker(makeWorkerTelemetry(() => undefined)).fetch(
            new Request(`https://api.fidyapp.com${path}`, {
              method: path === "/categories" ? "GET" : "POST",
              headers: {
                "content-type": "application/json",
                "cf-access-jwt-assertion": assertion,
                "cloudflare-workers-version-overrides": override,
                cookie: "test-only-session",
                ...(origin === "" ? {} : { origin }),
              },
            }),
            {
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              LOCAL_CANONICAL_READ_BEARER: "",
              PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
              RELEASE_GIT_SHA: "c".repeat(40),
              CORE: {
                fetch: (input) => {
                  reachedCore = true;
                  expect(
                    new Request(input).headers.get("cloudflare-workers-version-overrides")
                  ).toBeNull();
                  return Promise.resolve(new Response(null, { status: refusedStatus }));
                },
              },
            }
          )
        );
        expect(reachedCore).toBe(forwarded);
        expect(response.status).toBe(refusedStatus);
      })
    )
);
