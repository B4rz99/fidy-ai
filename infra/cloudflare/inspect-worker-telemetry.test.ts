import { it } from "@effect/vitest";
import { makeCloudflareObservabilityOutboundHttp } from "@fidy/server/outbound-http";
import { DateTime, Effect, Exit, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vitest";
import { inspectWorkerTelemetry, inspectWorkerTelemetryReport } from "./inspect-worker-telemetry";

const timestamp = "2026-10-02T15:16:41Z";
const center = DateTime.toEpochMillis(DateTime.makeUnsafe(timestamp));
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const revision = "66eecdfbba2a2b395bdc3e77dbc735de330d002b";
const core = "fidy-core";
const work = {
  release: revision,
  operation: "worker.core.fetch",
  outcome: "failed",
  statusClass: "5xx",
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeReport = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      inspectedEvents: Schema.Finite,
      unprojectedEvents: Schema.Finite,
      possiblyTruncated: Schema.Boolean,
      evidence: Schema.String,
      records: Schema.Array(
        Schema.Struct({
          timestamp: Schema.String,
          version: Schema.String,
          release: Schema.String,
          method: Schema.String,
          statusClass: Schema.String,
          outcome: Schema.String,
        })
      ),
    })
  )
);
const event = (overrides: object = {}): unknown => ({
  timestamp: center,
  source: work,
  $workers: {
    scriptName: core,
    scriptVersion: { id: version },
    event: { request: { method: "POST" } },
  },
  ...overrides,
});
const envelope = (events: ReadonlyArray<unknown>): unknown => ({
  success: true,
  result: { events: { events } },
});
const outboundFor = (
  httpClient: HttpClient.HttpClient,
  accountId = "00000000000000000000000000000000"
): ReturnType<typeof makeCloudflareObservabilityOutboundHttp> =>
  makeCloudflareObservabilityOutboundHttp({
    accountId,
    apiToken: Redacted.make("secret-token"),
    httpClient,
  });
const harness = (
  body: unknown,
  status = 200
): {
  requests: ReadonlyArray<string>;
  run: (time?: string) => ReturnType<typeof inspectWorkerTelemetry>;
} => {
  const requests: Array<string> = [];
  const outbound = outboundFor(
    HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(encodeJson(body), { status }))
      );
    })
  );
  return {
    requests,
    run: (time = timestamp): ReturnType<typeof inspectWorkerTelemetry> =>
      inspectWorkerTelemetry({ timestamp: time, workerName: core, outbound }).pipe(Effect.scoped),
  };
};

describe("protected Core telemetry inspection", () => {
  it.effect(
    "projects only validated identity and outcomes from existing logs",
    Effect.fn(function* () {
      const raw = yield* harness(
        envelope([
          event({
            source: { ...work, token: "private-token", userContent: "private-user-data" },
            $metadata: { message: "private-message", url: "private-url" },
          }),
        ])
      ).run();
      expect(decodeReport(raw).records).toEqual([
        {
          timestamp: "2026-10-02T15:16:41.000Z",
          version,
          release: revision,
          method: "POST",
          statusClass: "5xx",
          outcome: "failed",
        },
      ]);
      expect(raw).not.toMatch(/private-|secret-token/u);
    })
  );

  it.effect(
    "reads both Effect console inspect text and structured JSON without exporting messages",
    Effect.fn(function* () {
      const text = `[15:16:41] INFO (#1): {\n  release: "${revision}",\n  operation: "worker.core.fetch",\n  outcome: "failed",\n  statusClass: "5xx",\n  secret: "private-token"\n}`;
      const raw = yield* harness(
        envelope([
          event({ source: text }),
          event({ source: { message: text } }),
          event({ source: encodeJson(work) }),
          event({ source: {}, $metadata: { message: text } }),
        ])
      ).run();
      const report = decodeReport(raw);
      expect(report.records).toHaveLength(4);
      expect(report.records.every((record) => record.release === revision)).toBe(true);
      expect(raw).not.toMatch(/private-token|INFO|secret:/u);
    })
  );

  it.effect(
    "does not treat foreign Workers, other Work, or events outside the requested window as evidence",
    Effect.fn(function* () {
      const raw = yield* harness(
        envelope([
          event({ $workers: { scriptName: "other-worker" } }),
          event({ source: { ...work, operation: "http.transactions.list" } }),
          event({ timestamp: center + 60_001 }),
          event({ source: "private-unrecognized-log" }),
        ])
      ).run();
      expect(decodeReport(raw)).toMatchObject({ records: [], unprojectedEvents: 4 });
    })
  );

  it.effect(
    "projects method from native trigger metadata without disclosing request coordinates",
    Effect.fn(function* () {
      const raw = yield* harness(
        envelope([
          event({
            $workers: { scriptName: core, scriptVersion: { id: version } },
            $metadata: { trigger: "POST https://private-coordinate.example/path?private-query" },
          }),
        ])
      ).run();
      expect(decodeReport(raw).records[0]?.method).toBe("POST");
      expect(raw).not.toMatch(/private-|https:/u);
    })
  );

  it.effect(
    "keeps missing version and method inconclusive instead of inventing identity",
    Effect.fn(function* () {
      const report = decodeReport(
        yield* harness(envelope([event({ $workers: { scriptName: core } })])).run()
      );
      expect(report.records[0]).toMatchObject({ version: "unavailable", method: "unavailable" });
      expect(report.evidence).toContain("not proof");
    })
  );

  it.effect(
    "reports empty windows and a full page without implying complete or successful smoke evidence",
    Effect.fn(function* () {
      const empty = decodeReport(yield* harness(envelope([])).run());
      expect(empty).toMatchObject({ records: [], possiblyTruncated: false });
      const full = decodeReport(
        yield* harness(envelope(Array.from({ length: 100 }, () => event()))).run()
      );
      expect(full.possiblyTruncated).toBe(true);
    })
  );

  it.effect.each(["2026-02-30T15:16:41Z", "not-a-time", "2026-10-02T15:16:41Z; echo secret"])(
    "rejects invalid time %s before calling Cloudflare",
    Effect.fn(function* (time) {
      const fixture = harness(envelope([]));
      const failure = yield* Effect.flip(fixture.run(time));
      expect(failure.reason).toBe("invalid-time");
      expect(fixture.requests).toEqual([]);
    })
  );

  it.effect.each([401, 403, 500, 302])(
    "contains provider body and error details for HTTP %s",
    Effect.fn(function* (status) {
      const fixture = harness({ errors: [{ message: "private-cloudflare-body" }] }, status);
      const failure = yield* Effect.flip(fixture.run());
      expect(failure.reason).toBe(
        status === 401 || status === 403 ? "query-denied" : "query-failed"
      );
      expect(encodeJson(failure)).not.toContain("private-cloudflare-body");
    })
  );

  it.effect.each([
    { success: false, errors: [{ message: "private-error" }] },
    envelope([event({ $workers: { scriptName: core, scriptVersion: { id: "private-id" } } })]),
    envelope(Array.from({ length: 101 }, () => event())),
  ])(
    "refuses malformed or over-limit query responses without printing payloads",
    Effect.fn(function* (body) {
      const failure = yield* Effect.flip(harness(body).run());
      expect(failure.reason).toBe("invalid-response");
      expect(encodeJson(failure)).not.toMatch(/private-error|private-id/u);
    })
  );

  it.effect(
    "uses a fixed destination, Core-only filter and bounded temporary query without credential propagation",
    Effect.fn(function* () {
      const httpClient = HttpClient.make((request) => {
        expect(request.url).toBe(
          "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/workers/observability/telemetry/query"
        );
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe("Bearer secret-token");
        expect(request.headers.traceparent).toBeUndefined();
        expect(request.body._tag).toBe("Uint8Array");
        if (request.body._tag === "Uint8Array") {
          expect(decodeJson(new TextDecoder().decode(request.body.body))).toMatchObject({
            timeframe: { from: center - 60_000, to: center + 60_000 },
            limit: 100,
            parameters: {
              filters: [
                { key: "$workers.scriptName", operation: "eq", type: "string", value: core },
              ],
            },
          });
        }
        return Effect.gen(function* () {
          const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
          expect(requestInit).toEqual(Option.some({ redirect: "error" }));
          return HttpClientResponse.fromWeb(request, Response.json(envelope([])));
        });
      });
      yield* inspectWorkerTelemetry({
        timestamp,
        workerName: core,
        outbound: outboundFor(httpClient),
      }).pipe(Effect.withSpan("inspection"), Effect.scoped);
    })
  );

  it.effect(
    "reports denied access without changing the original inspection verdict",
    Effect.fn(function* () {
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ errors: [{ message: "private-provider-error" }] }, { status: 403 })
          )
        )
      );
      const report = yield* inspectWorkerTelemetryReport({
        timestamp,
        workerName: core,
        outbound: outboundFor(httpClient),
      }).pipe(Effect.scoped);
      expect(report).toBe("Core telemetry unavailable (query-denied).");
    })
  );

  it.effect.each([
    { workerName: "core/private", from: center, to: center + 1 },
    { workerName: core, from: center, to: center },
    { workerName: core, from: center + 1, to: center },
    { workerName: core, from: center, to: center + 120_001 },
    { workerName: core, from: -1, to: 1 },
  ])(
    "refuses invalid operational query authority before issuing HTTP",
    Effect.fn(function* (query) {
      let requested = false;
      const httpClient = HttpClient.make((request) => {
        requested = true;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(envelope([]))));
      });
      const exit = yield* Effect.exit(
        outboundFor(httpClient).execute({ _tag: "CloudflareWorkerTelemetry", ...query })
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(requested).toBe(false);
    })
  );

  it.effect(
    "never turns observability authority into another provider mutation or arbitrary account path",
    Effect.fn(function* () {
      let requested = false;
      const httpClient = HttpClient.make((request) => {
        requested = true;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(envelope([]))));
      });
      const outbound = outboundFor(httpClient, "malicious/account");
      const exits = yield* Effect.all([
        Effect.exit(
          outbound.execute({
            _tag: "CloudflareWorkerTelemetry",
            workerName: core,
            from: center,
            to: center + 1,
          })
        ),
        Effect.exit(
          outbound.execute({
            _tag: "ResendEmailDelivery",
            body: "private-body",
            idempotencyKey: "private-key",
          })
        ),
      ]);
      expect(exits.every(Exit.isFailure)).toBe(true);
      expect(requested).toBe(false);
    })
  );

  it.effect(
    "rejects oversized streamed responses and releases the reader without exposing their contents",
    Effect.fn(function* () {
      let cancelled = false;
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                pull(controller): void {
                  controller.enqueue(new Uint8Array(1_048_577));
                },
                cancel(): void {
                  cancelled = true;
                },
              })
            )
          )
        )
      );
      const failure = yield* Effect.flip(
        inspectWorkerTelemetry({
          timestamp,
          workerName: core,
          outbound: outboundFor(httpClient),
        }).pipe(Effect.scoped)
      );
      expect(failure.reason).toBe("query-failed");
      expect(cancelled).toBe(true);
    })
  );
});
