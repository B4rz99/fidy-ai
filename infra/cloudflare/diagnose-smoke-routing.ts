/// <reference types="bun-types" />

import { Context, Data, Effect, Exit, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { exchangeSmoke, observeSmokeCore, smokeHeaders } from "./smoke-exchange";
import {
  SmokeIdentity,
  SmokeRequest,
  smokeDiagnosticRevision,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";

const RoutingConfig = Schema.Struct({
  PUBLIC_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  CORE_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  STABLE_PUBLIC_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  STABLE_CORE_VERSION_ID: SmokeIdentity.fields.workerVersionId,
  CONTRACT_DIGEST: SmokeIdentity.fields.contractDigest,
  PUBLIC_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  CORE_WORKER_NAME: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  SMOKE_PROOF: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  SMOKE_ROUTING_WINDOW: Schema.optionalKey(Schema.Literals(["early", "settled"])),
});
type RoutingConfig = typeof RoutingConfig.Type;
export type RoutingObservation = Readonly<{
  round: number;
  pairing: "candidate" | "intermediate";
  method: "GET" | "POST";
  replica: 1 | 2;
  window: "early" | "settled";
  status: number;
  publicVersion: string;
  coreVersion: string;
  coreSource: "body" | "header" | "equality" | "unavailable";
}>;
type RoutingSample = Pick<
  RoutingObservation,
  "round" | "pairing" | "method" | "replica" | "window"
>;
class RoutingDiagnosticFailed extends Data.TaggedError("RoutingDiagnosticFailed")<{}> {}
const rounds = 6;
const ordinarySamplesPerRound = 8;
const readyStatus = 200;
const refusedStatus = 503;
const diagnosticProbeId = "00000000000000000000000000000000";
const routingRequest = Effect.fn(function* (config: RoutingConfig, sample: RoutingSample) {
  const publicVersion =
    sample.pairing === "candidate" ? config.PUBLIC_VERSION_ID : config.STABLE_PUBLIC_VERSION_ID;
  const headers = smokeHeaders({ config, publicVersion: Option.some(publicVersion) });
  // Both methods use the same URL and override. The reserved revision stops POST effects,
  // even on older Core code, whose Production revision cannot be all-zero.
  const query = "?readiness=1";
  if (sample.method === "GET") return { query, headers, body: Option.none<string>() };
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(SmokeRequest))({
    protocolVersion: 1,
    probeId: diagnosticProbeId,
    expectedPublicVersionId: publicVersion,
    expectedCoreVersionId: config.STABLE_CORE_VERSION_ID,
    expectedGitRevision: smokeDiagnosticRevision,
    expectedContractDigest: config.CONTRACT_DIGEST,
  });
  return { query, headers, body: Option.some(body) };
});

const observeRouting = Effect.fn(
  function* (config: RoutingConfig, sample: RoutingSample) {
    const request = yield* routingRequest(config, sample);
    const response = yield* exchangeSmoke(request);
    const observedPublic = response.publicVersion;
    const core = observeSmokeCore({
      response,
      method: sample.method,
      stableCore: config.STABLE_CORE_VERSION_ID,
    });
    return {
      ...sample,
      status: response.status,
      publicVersion: Option.getOrElse(observedPublic, () => "unavailable"),
      coreVersion: Option.getOrElse(core.version, () => "unavailable"),
      coreSource: core.source,
    } satisfies RoutingObservation;
  },
  Effect.scoped,
  Effect.timeout("8 seconds"),
  Effect.mapError(() => new RoutingDiagnosticFailed())
);

const routingSamples = (
  round: number,
  window: RoutingSample["window"]
): ReadonlyArray<RoutingSample> => {
  const probes: RoutingSample[] = [];
  for (const replica of [1, 2] as const) {
    for (const method of ["GET", "POST"] as const) {
      for (const pairing of ["candidate", "intermediate"] as const) {
        probes.push({ round, pairing, method, replica, window });
      }
    }
  }
  return probes;
};

const matchesRoutingIdentity = (value: RoutingObservation, config: RoutingConfig): boolean =>
  value.coreVersion === config.CORE_VERSION_ID &&
  value.publicVersion ===
    (value.pairing === "candidate" ? config.PUBLIC_VERSION_ID : config.STABLE_PUBLIC_VERSION_ID);

const matchesReadOnlyProtocol = (value: RoutingObservation): boolean =>
  value.status === (value.method === "GET" ? readyStatus : refusedStatus) &&
  value.coreSource === (value.method === "GET" ? "body" : "header");

/** Exact, complete ordinary-call observations after settling; never a synthetic-work attestation. */
export const settledRoutingAccepted = ({
  env,
  observations,
}: Readonly<{
  env: unknown;
  observations: ReadonlyArray<RoutingObservation>;
}>): boolean => {
  const decoded = Schema.decodeUnknownOption(RoutingConfig)(env);
  if (Option.isNone(decoded)) return false;
  const required = observations.filter((value) => value.window === "settled");
  const identities = new Set(
    required.map((value) => `${value.round}:${value.pairing}:${value.method}:${value.replica}`)
  );
  return (
    required.length === rounds * ordinarySamplesPerRound &&
    identities.size === rounds * ordinarySamplesPerRound &&
    required.every(
      (value) =>
        value.round >= 1 &&
        value.round <= rounds &&
        Number.isInteger(value.round) &&
        matchesRoutingIdentity(value, decoded.value) &&
        matchesReadOnlyProtocol(value)
    )
  );
};

/** Bounded GET/POST observations only; never publishes work, writes an attestation, or changes traffic. */
export const diagnoseSmokeRouting = Effect.fn(function* (env: unknown) {
  const decoded = Schema.decodeUnknownOption(RoutingConfig)(env);
  if (Option.isNone(decoded)) return yield* new RoutingDiagnosticFailed();
  const window = decoded.value.SMOKE_ROUTING_WINDOW ?? "early";
  // Settling precedes the convergence gate, never replaces exact-pair synthetic smoke.
  if (window === "settled") yield* Effect.sleep("60 seconds");
  const observations: RoutingObservation[] = [];
  for (let round = 1; round <= rounds; round++) {
    const samples = yield* Effect.forEach(
      routingSamples(round, window),
      (sample) => observeRouting(decoded.value, sample),
      { concurrency: ordinarySamplesPerRound }
    );
    observations.push(...samples);
    if (round < rounds) yield* Effect.sleep("1500 millis");
  }
  const result: ReadonlyArray<RoutingObservation> = observations;
  return result;
}, Effect.timeout("125 seconds"));

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(FetchHttpClient.layer);
        return yield* diagnoseSmokeRouting(process.env).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            Context.get(services, HttpClient.HttpClient)
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        );
      })
    )
  );
  if (Exit.isSuccess(result)) {
    await Bun.write(
      Bun.stdout,
      result.value
        .map((observation) => `Smoke routing observation: ${JSON.stringify(observation)}\n`)
        .join("")
    );
    if (
      result.value.some((value) => value.window === "settled") &&
      !settledRoutingAccepted({ env: process.env, observations: result.value })
    ) {
      await Bun.write(
        Bun.stderr,
        "Settled smoke routing rejected; synthetic work and promotion must not start.\n"
      );
      process.exitCode = 1;
    }
  } else {
    await Bun.write(
      Bun.stderr,
      "Smoke routing observations unavailable; no diagnostic attestation issued.\n"
    );
    process.exitCode = 1;
  }
}
