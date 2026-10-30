import { telemetryTraceHeader } from "~/shell/browser-transport/contract";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { TelemetryTraceId } from "../src/shell/observability/contract";
import { WorkerTelemetryEvent, workerInternalTraceHeader } from "./runtime/telemetry/contract";
import { makeWorkerTelemetry } from "./runtime/telemetry/operations";
import { makePublicWorker } from "./public-worker";

it.effect("replaces public trace claims with a server receipt and private continuation", () =>
  Effect.gen(function* () {
    const events: WorkerTelemetryEvent[] = [];
    const worker = makePublicWorker(
      makeWorkerTelemetry({
        exportWork: () => undefined,
        exportEvent: (event) => events.push(event),
      })
    );
    const callerTrace = "a".repeat(32);
    const privateClaim = `00-${callerTrace}-${"b".repeat(16)}-01`;
    let forwardedTrace = "";
    const response = yield* Effect.tryPromise(() =>
      worker.fetch(
        new Request("https://api.fidyapp.com/categories?private=financial-canary", {
          headers: {
            origin: "https://app.fidyapp.com",
            cookie: "private-cookie-canary",
            traceparent: privateClaim,
            [workerInternalTraceHeader]: privateClaim,
            [telemetryTraceHeader]: callerTrace,
            baggage: "private-baggage-canary",
          },
        }),
        {
          BROWSER_ORIGIN: "https://app.fidyapp.com",
          LOCAL_CANONICAL_READ_BEARER: "",
          PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
          RELEASE_GIT_SHA: "c".repeat(40),
          CORE: {
            fetch: (input) => {
              expect(input).toBeInstanceOf(Request);
              const request = new Request(input);
              forwardedTrace = request.headers.get(workerInternalTraceHeader) ?? "";
              expect(request.headers.has("traceparent")).toBe(false);
              expect(request.headers.has("baggage")).toBe(false);
              expect(request.headers.has(telemetryTraceHeader)).toBe(false);
              return Promise.resolve(
                new Response(null, {
                  status: 503,
                  headers: { [telemetryTraceHeader]: callerTrace },
                })
              );
            },
          },
        }
      )
    );
    const receipt = yield* Schema.decodeUnknownEffect(TelemetryTraceId)(
      response.headers.get(telemetryTraceHeader)
    );
    expect(receipt).not.toBe(callerTrace);
    expect(forwardedTrace).toMatch(new RegExp(`^00-${receipt}-[0-9a-f]{16}-01$`, "u"));
    expect(response.headers.get("access-control-expose-headers")).toContain(telemetryTraceHeader);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.status).toBe(503);
    expect(events.some((event) => event.event === "span" && event.traceId === receipt)).toBe(true);
    const exported = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(WorkerTelemetryEvent))
    )(events);
    for (const sentinel of [
      "financial-canary",
      "private-cookie-canary",
      "private-baggage-canary",
    ]) {
      expect(exported).not.toContain(sentinel);
    }
  })
);

it.effect("returns a fresh diagnostic receipt for an ingress refusal without reaching Core", () =>
  Effect.gen(function* () {
    const worker = makePublicWorker(makeWorkerTelemetry(() => undefined));
    let forwarded = false;
    const response = yield* Effect.tryPromise(() =>
      worker.fetch(new Request("https://api.fidyapp.com/unknown"), {
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        LOCAL_CANONICAL_READ_BEARER: "",
        PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
        RELEASE_GIT_SHA: "c".repeat(40),
        CORE: {
          fetch: () => {
            forwarded = true;
            return Promise.resolve(new Response());
          },
        },
      })
    );
    expect(response.status).toBe(404);
    expect(forwarded).toBe(false);
    expect(Schema.is(TelemetryTraceId)(response.headers.get(telemetryTraceHeader))).toBe(true);
  })
);
