import { it } from "@effect/vitest";
import type { TelemetryWorkRecord } from "@fidy/server/telemetry";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
  makeWorkerTelemetry,
  observeModelRun,
  observeProviderFetch,
  observeWorkerExecution,
  observeWorkerPromise,
  observeWorkerResponse,
  workerRelease,
} from "./telemetry";

it.effect("reports a durable attempt without replacing its rejection or exporting its cause", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const failure = new Error("private-financial-payload");
    const result = observeWorkerPromise(() => Promise.reject(failure), {
      environment: { RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567" },
      telemetry: makeWorkerTelemetry((record) => {
        records.push(record);
      }),
      operation: "workflow.billingCollection",
    });
    yield* Effect.tryPromise(() => expect(result).rejects.toBe(failure));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "workflow.billingCollection",
      outcome: "failed",
    });
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain(failure.message);
  })
);

it.effect("projects release smoke telemetry without proof, probe ID, or User data", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const environment = { RELEASE_GIT_SHA: "a".repeat(40), SMOKE_PROOF: "proof-canary" };
    const result = observeWorkerPromise(() => Promise.resolve("probe-canary"), {
      environment,
      telemetry: makeWorkerTelemetry((record) => {
        records.push(record);
      }),
      operation: "workflow.releaseSmoke",
    });
    expect(yield* Effect.tryPromise(() => result)).toBe("probe-canary");
    expect(records).toMatchObject([
      { operation: "workflow.releaseSmoke", outcome: "succeeded", release: "a".repeat(40) },
    ]);
    const projected = records.flatMap((record) => Object.values(record)).join(" ");
    expect(projected).not.toContain("proof-canary");
    expect(projected).not.toContain("probe-canary");
  })
);

it("extracts only a valid release from an environment containing secrets", () => {
  expect(
    workerRelease({ RELEASE_GIT_SHA: "a".repeat(40), RESEND_API_KEY: "secret-canary" })
  ).toEqual({ RELEASE_GIT_SHA: "a".repeat(40) });
});

it.effect(
  "reports unavailable coordinator responses as failures without changing the response",
  () =>
    Effect.gen(function* () {
      const records: TelemetryWorkRecord[] = [];
      const unavailable = new Response(null, { status: 503 });
      const response = yield* Effect.tryPromise(() =>
        observeWorkerResponse(() => Promise.resolve(unavailable), {
          environment: { RELEASE_GIT_SHA: "invalid" },
          telemetry: makeWorkerTelemetry((record) => {
            records.push(record);
          }),
          operation: "worker.core.coordinator",
        })
      );
      expect(response).toBe(unavailable);
      expect(records).toMatchObject([
        { operation: "worker.core.coordinator", outcome: "failed", statusClass: "5xx" },
      ]);
    })
);

it.effect("preserves an interrupted Effect exit and projects one interrupted record", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const exit = yield* Effect.tryPromise(() =>
      Effect.runPromiseExit(
        observeWorkerExecution(Effect.interrupt, {
          environment: { RELEASE_GIT_SHA: "invalid" },
          telemetry: makeWorkerTelemetry((record) => {
            records.push(record);
          }),
          operation: "worker.email.receive",
        })
      )
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(records).toMatchObject([{ operation: "worker.email.receive", outcome: "interrupted" }]);
  })
);

it.effect("reports model response status without exporting its prompt or response", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const response = Response.json({ privateResponse: "financial-canary" });
    const actual = yield* Effect.tryPromise(() =>
      observeModelRun(() => Promise.resolve(response), {
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      })
    );
    expect(actual).toBe(response);
    expect(records).toMatchObject([
      {
        operation: "model.workersAi",
        provider: "cloudflare-workers-ai",
        release: "unknown",
        statusClass: "2xx",
        outcome: "succeeded",
      },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("financial-canary");
  })
);

it.effect("reports only a provider status class, not the response body", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const response = Response.json({ secret: "card-canary" }, { status: 502 });
    const fetcher = observeProviderFetch(
      Object.assign(() => Promise.resolve(response), { preconnect: () => {} }),
      {
        provider: "wompi",
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      }
    );
    expect(
      yield* Effect.tryPromise(() => fetcher("https://provider.example/secret?card=card-canary"))
    ).toBe(response);
    expect(records).toMatchObject([
      { operation: "provider.request", provider: "wompi", outcome: "failed", statusClass: "5xx" },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("card-canary");
  })
);

it.effect("reports provider transport failure without exporting its destination or request", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const failure = new Error("https://secret.example/path?token=private-canary");
    const fetcher = observeProviderFetch(
      Object.assign(() => Promise.reject<Response>(failure), { preconnect: () => {} }),
      {
        provider: "wompi",
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      }
    );
    yield* Effect.tryPromise(() =>
      expect(fetcher("https://secret.example/path?token=private-canary")).rejects.toBe(failure)
    );
    expect(records).toMatchObject([
      { operation: "provider.request", provider: "wompi", outcome: "failed" },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("private-canary");
  })
);

it.effect("does not change successful durable Work when the exporter throws", () =>
  Effect.gen(function* () {
    const result = observeWorkerPromise(() => Promise.resolve("unchanged"), {
      environment: { RELEASE_GIT_SHA: "bad-release" },
      telemetry: makeWorkerTelemetry(() => {
        throw new Error("export unavailable");
      }),
      operation: "workflow.billingCollection",
    });
    expect(yield* Effect.tryPromise(() => result)).toBe("unchanged");
  })
);
