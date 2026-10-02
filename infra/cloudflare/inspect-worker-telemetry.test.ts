import { makeCloudflareObservabilityOutboundHttp } from "@fidy/server/outbound-http";
import { Effect, Exit, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { inspectWorkerTelemetry, inspectWorkerTelemetryReport } from "./inspect-worker-telemetry";

const timestamp = "2026-10-02T15:16:41Z";
const center = Date.parse(timestamp);
const version = "dc8dcd28-271b-4367-9840-6c244f84cb40";
const revision = "66eecdfbba2a2b395bdc3e77dbc735de330d002b";
const core = "fidy-core";
const work = {
  release: revision,
  operation: "worker.core.fetch",
  outcome: "failed",
  statusClass: "5xx",
};
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

const harness = (
  body: unknown,
  status = 200
): {
  requests: ReadonlyArray<string>;
  run: (time?: string) => Promise<string>;
  exit: () => Promise<Exit.Exit<string, unknown>>;
} => {
  const requests: Array<string> = [];
  const httpClient = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))
    );
  });
  const outbound = makeCloudflareObservabilityOutboundHttp({
    accountId: "00000000000000000000000000000000",
    apiToken: Redacted.make("secret-token"),
    httpClient,
  });
  return {
    requests,
    run: (time = timestamp): Promise<string> =>
      Effect.runPromise(
        inspectWorkerTelemetry({
          timestamp: time,
          workerName: core,
          outbound,
        }).pipe(Effect.scoped)
      ),
    exit: (): Promise<Exit.Exit<string, unknown>> =>
      Effect.runPromiseExit(
        inspectWorkerTelemetry({ timestamp, workerName: core, outbound }).pipe(Effect.scoped)
      ),
  };
};

describe("protected Core telemetry inspection", () => {
  it("projects only validated identity and outcomes from existing logs", async () => {
    const fixture = harness(
      envelope([
        event({
          source: {
            ...work,
            token: "private-token",
            userContent: "private-user-data",
          },
          $metadata: { message: "private-message", url: "private-url" },
        }),
      ])
    );
    const report = JSON.parse(await fixture.run());
    expect(report.records).toEqual([
      {
        timestamp: "2026-10-02T15:16:41.000Z",
        version,
        release: revision,
        method: "POST",
        statusClass: "5xx",
        outcome: "failed",
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/private-|secret-token/u);
  });

  it("reads both Effect console inspect text and structured JSON without exporting messages", async () => {
    const text = `[15:16:41] INFO (#1): {\n  release: "${revision}",\n  operation: "worker.core.fetch",\n  outcome: "failed",\n  statusClass: "5xx",\n  secret: "private-token"\n}`;
    const report = JSON.parse(
      await harness(
        envelope([
          event({ source: text }),
          event({ source: { message: text } }),
          event({ source: JSON.stringify(work) }),
          event({ source: {}, $metadata: { message: text } }),
        ])
      ).run()
    );
    expect(report.records).toHaveLength(4);
    expect(report.records.every((record: { release: string }) => record.release === revision)).toBe(
      true
    );
    expect(JSON.stringify(report)).not.toMatch(/private-token|INFO|secret:/u);
  });

  it("does not treat foreign Workers, other Work, or events outside the requested window as evidence", async () => {
    const report = JSON.parse(
      await harness(
        envelope([
          event({ $workers: { scriptName: "other-worker" } }),
          event({ source: { ...work, operation: "http.transactions.list" } }),
          event({ timestamp: center + 60_001 }),
          event({ source: "private-unrecognized-log" }),
        ])
      ).run()
    );
    expect(report.records).toEqual([]);
    expect(report.unprojectedEvents).toBe(4);
  });

  it("projects method from native trigger metadata without disclosing request coordinates", async () => {
    const report = JSON.parse(
      await harness(
        envelope([
          event({
            $workers: { scriptName: core, scriptVersion: { id: version } },
            $metadata: { trigger: "POST https://private-coordinate.example/path?private-query" },
          }),
        ])
      ).run()
    );
    expect(report.records[0].method).toBe("POST");
    expect(JSON.stringify(report)).not.toMatch(/private-|https:/u);
  });

  it("keeps missing version and method inconclusive instead of inventing identity", async () => {
    const report = JSON.parse(
      await harness(envelope([event({ $workers: { scriptName: core } })])).run()
    );
    expect(report.records[0]).toMatchObject({
      version: "unavailable",
      method: "unavailable",
    });
    expect(report.evidence).toContain("not proof");
  });

  it("reports empty windows and a full page without implying complete or successful smoke evidence", async () => {
    const empty = JSON.parse(await harness(envelope([])).run());
    expect(empty.records).toEqual([]);
    expect(empty.possiblyTruncated).toBe(false);
    const full = JSON.parse(
      await harness(envelope(Array.from({ length: 100 }, () => event()))).run()
    );
    expect(full.possiblyTruncated).toBe(true);
  });

  it.each(["2026-02-30T15:16:41Z", "not-a-time", "2026-10-02T15:16:41Z; echo secret"])(
    "rejects invalid time %s before calling Cloudflare",
    async (time) => {
      const fixture = harness(envelope([]));
      await expect(fixture.run(time)).rejects.toMatchObject({
        reason: "invalid-time",
      });
      expect(fixture.requests).toEqual([]);
    }
  );

  it.each([401, 403, 500, 302])(
    "contains provider body and error details for HTTP %s",
    async (status) => {
      const fixture = harness({ errors: [{ message: "private-cloudflare-body" }] }, status);
      const exit = await fixture.exit();
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("private-cloudflare-body");
      await expect(fixture.run()).rejects.toMatchObject({
        reason: status === 401 || status === 403 ? "query-denied" : "query-failed",
      });
    }
  );

  it.each([
    { success: false, errors: [{ message: "private-error" }] },
    envelope([
      event({
        $workers: { scriptName: core, scriptVersion: { id: "private-id" } },
      }),
    ]),
    envelope(Array.from({ length: 101 }, () => event())),
  ])("refuses malformed or over-limit query responses without printing payloads", async (body) => {
    const fixture = harness(body);
    await expect(fixture.run()).rejects.toMatchObject({
      reason: "invalid-response",
    });
    expect(JSON.stringify(await fixture.exit())).not.toMatch(/private-error|private-id/u);
  });

  it("uses a fixed destination, Core-only filter and bounded temporary query without credential propagation", async () => {
    const httpClient = HttpClient.make((request) => {
      expect(request.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/workers/observability/telemetry/query"
      );
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe("Bearer secret-token");
      expect(request.headers.traceparent).toBeUndefined();
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array") {
        const query = JSON.parse(new TextDecoder().decode(request.body.body));
        expect(query.timeframe).toEqual({
          from: center - 60_000,
          to: center + 60_000,
        });
        expect(query.limit).toBe(100);
        expect(query.parameters.filters).toEqual([
          {
            key: "$workers.scriptName",
            operation: "eq",
            type: "string",
            value: core,
          },
        ]);
      }
      return Effect.gen(function* () {
        const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
        expect(requestInit).toEqual(Option.some({ redirect: "error" }));
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(envelope([]))));
      });
    });
    const outbound = makeCloudflareObservabilityOutboundHttp({
      accountId: "00000000000000000000000000000000",
      apiToken: Redacted.make("secret-token"),
      httpClient,
    });
    await Effect.runPromise(
      inspectWorkerTelemetry({ timestamp, workerName: core, outbound }).pipe(
        Effect.withSpan("inspection"),
        Effect.scoped
      )
    );
  });

  it("reports denied access without changing the original inspection verdict", async () => {
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ errors: [{ message: "private-provider-error" }] }, { status: 403 })
        )
      )
    );
    const outbound = makeCloudflareObservabilityOutboundHttp({
      accountId: "00000000000000000000000000000000",
      apiToken: Redacted.make("secret-token"),
      httpClient,
    });
    const report = await Effect.runPromise(
      inspectWorkerTelemetryReport({ timestamp, workerName: core, outbound }).pipe(Effect.scoped)
    );
    expect(report).toBe("Core telemetry unavailable (query-denied).");
  });

  it.each([
    { workerName: "core/private", from: center, to: center + 1 },
    { workerName: core, from: center, to: center },
    { workerName: core, from: center + 1, to: center },
    { workerName: core, from: center, to: center + 120_001 },
    { workerName: core, from: -1, to: 1 },
  ])("refuses invalid operational query authority before issuing HTTP", async (query) => {
    let requested = false;
    const httpClient = HttpClient.make((request) => {
      requested = true;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(envelope([]))));
    });
    const outbound = makeCloudflareObservabilityOutboundHttp({
      accountId: "00000000000000000000000000000000",
      apiToken: Redacted.make("secret-token"),
      httpClient,
    });
    const exit = await Effect.runPromiseExit(
      outbound.execute({ _tag: "CloudflareWorkerTelemetry", ...query }).pipe(Effect.scoped)
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(requested).toBe(false);
  });

  it("never turns observability authority into another provider mutation or arbitrary account path", async () => {
    let requested = false;
    const httpClient = HttpClient.make((request) => {
      requested = true;
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(envelope([]))));
    });
    const outbound = makeCloudflareObservabilityOutboundHttp({
      accountId: "malicious/account",
      apiToken: Redacted.make("secret-token"),
      httpClient,
    });
    const exits = await Effect.runPromise(
      Effect.all([
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
      ]).pipe(Effect.scoped)
    );
    expect(exits.every(Exit.isFailure)).toBe(true);
    expect(requested).toBe(false);
  });

  it("rejects oversized streamed responses and releases the reader without exposing their contents", async () => {
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
    const outbound = makeCloudflareObservabilityOutboundHttp({
      accountId: "00000000000000000000000000000000",
      apiToken: Redacted.make("secret-token"),
      httpClient,
    });
    await expect(
      Effect.runPromise(
        inspectWorkerTelemetry({ timestamp, workerName: core, outbound }).pipe(Effect.scoped)
      )
    ).rejects.toMatchObject({ reason: "query-failed" });
    expect(cancelled).toBe(true);
  });
});
