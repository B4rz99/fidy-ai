import { Effect, Option, Schedule, Schema } from "effect";
import { type HttpClient } from "effect/http";
import { Hex } from "effect/encoding";
import {
  type SmokeIdentity,
  SmokeRequest,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  CandidateRoutingPending,
  ReleaseSmokeFailed,
  checkSmokeExchange,
  exchangeSmoke,
} from "./smoke-exchange";

const maximumPolls = 24,
  entropyBytes = 16;

export const verifyNativeSmoke = Effect.fn(function* (input: {
  api: string;
  headers: Readonly<Record<string, string>>;
  public: SmokeIdentity;
  core: SmokeIdentity;
}) {
  const probeId = Hex.encode(crypto.getRandomValues(new Uint8Array(entropyBytes)));

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(SmokeRequest))({
    probeId,
    protocolVersion: 1,
    expectedPublicVersionId: input.public.workerVersionId,
    expectedCoreVersionId: input.core.workerVersionId,
    expectedGitRevision: input.core.gitRevision,
    expectedContractDigest: input.core.contractDigest,
  });

  const execute = (
    query: string,
    request: Option.Option<string>,
    replayIdentity: boolean
  ): Effect.Effect<
    "passed" | "pending",
    ReleaseSmokeFailed | CandidateRoutingPending,
    HttpClient.HttpClient
  > =>
    exchangeSmoke({ query, headers: input.headers, body: request }, input.api).pipe(
      Effect.flatMap((result) =>
        checkSmokeExchange(result, { public: input.public, core: input.core, replayIdentity })
      )
    );

  let status = yield* execute("", Option.some(body), true).pipe(
    Effect.retry({
      times: 6,
      schedule: Schedule.spaced("1500 millis"),
      while: (error) => error instanceof CandidateRoutingPending,
    })
  );

  for (let attempt = 0; attempt < maximumPolls && status !== "passed"; attempt++) {
    yield* Effect.sleep("1500 millis");
    status = yield* execute("?probeId=" + probeId, Option.none(), false);
  }

  if (status !== "passed") {
    return yield* new ReleaseSmokeFailed({
      reason: "Native release Queue and Workflow did not complete",
    });
  }

  return { probeId, status };
});
