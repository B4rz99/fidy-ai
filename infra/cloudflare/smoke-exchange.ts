import { Cause, Data, Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import {
  SmokeFailureStage,
  SmokeIdentity,
  SmokeIdentityEquality,
  SmokeResponse,
  smokeCoreVersionHeader,
  smokeFailureHeader,
  smokeIdentityHeader,
  smokePath,
} from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { verifySmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/operations";

const SmokeResult = Schema.Struct({ ...SmokeResponse.fields, public: SmokeIdentity });
const responseLimit = 4096;
const successStart = 200;
const successEnd = 300;
const refusedStatus = 503;
export class ReleaseSmokeFailed extends Data.TaggedError("ReleaseSmokeFailed")<{
  readonly reason: string;
}> {}
export class CandidateRoutingPending extends Data.TaggedError("CandidateRoutingPending")<{
  readonly reason: string;
}> {}

/** Proof authority is identical for normal traffic and exact-version calls; only pinned calls carry overrides. */
export const smokeHeaders = ({
  config,
  publicVersion,
}: Readonly<{
  config: Readonly<{
    SMOKE_PROOF: string;
    PUBLIC_WORKER_NAME: string;
    CORE_WORKER_NAME: string;
    CORE_VERSION_ID: string;
  }>;
  publicVersion: Option.Option<string>;
}>): Readonly<Record<string, string>> => ({
  "x-fidy-smoke-proof": config.SMOKE_PROOF,
  ...(Option.isSome(publicVersion)
    ? {
        "cloudflare-workers-version-overrides": `${config.PUBLIC_WORKER_NAME}="${publicVersion.value}", ${config.CORE_WORKER_NAME}="${config.CORE_VERSION_ID}"`,
      }
    : {}),
});

type SmokeExchange = Readonly<{
  status: number;
  noStore: boolean;
  publicVersion: Option.Option<string>;
  failureStage: Option.Option<SmokeFailureStage>;
  equality: Option.Option<typeof SmokeIdentityEquality.Type>;
  coreVersion: Option.Option<string>;
  result: Option.Option<typeof SmokeResult.Type>;
}>;

/** A single bounded proof exchange. No raw body or foreign failure escapes; interruption cancels the reader.
 * Malformed JSON is an absent identity, while overflow/transport failure fails the exchange. No retries occur here.
 */
export const exchangeSmoke = Effect.fn(
  function* (
    input: Readonly<{
      query: string;
      headers: Readonly<Record<string, string>>;
      body: Option.Option<string>;
    }>
  ) {
    const client = yield* HttpClient.HttpClient;
    const url = `https://api.fidyapp.com${smokePath}${input.query}`;
    const request = Option.isSome(input.body)
      ? HttpClientRequest.post(url, {
          headers: input.headers,
          body: HttpBody.text(input.body.value, "application/json"),
        })
      : HttpClientRequest.get(url, { headers: input.headers });
    const response = yield* HttpClient.withScope(client).execute(request);
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(response.stream, (chunk) => {
      size += chunk.byteLength;
      if (size > responseLimit) {
        return Effect.fail(
          new ReleaseSmokeFailed({ reason: "Smoke response exceeded its byte budget" })
        );
      }
      chunks.push(chunk);
      return Effect.void;
    }).pipe(Effect.catchReason("HttpClientError", "EmptyBodyError", () => Effect.void));
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      status: response.status,
      noStore: response.headers["cache-control"] === "no-store",
      publicVersion: Schema.decodeUnknownOption(SmokeIdentity.fields.workerVersionId)(
        response.headers["x-fidy-smoke-worker-version"]
      ),
      failureStage: Schema.decodeUnknownOption(SmokeFailureStage)(
        response.headers[smokeFailureHeader]
      ),
      equality: Schema.decodeUnknownOption(SmokeIdentityEquality)(
        response.headers[smokeIdentityHeader]
      ),
      coreVersion: Schema.decodeUnknownOption(SmokeIdentity.fields.workerVersionId)(
        response.headers[smokeCoreVersionHeader]
      ),
      result: Schema.decodeOption(Schema.fromJsonString(SmokeResult))(
        new TextDecoder().decode(bytes)
      ),
    } satisfies SmokeExchange;
  },
  Effect.scoped,
  Effect.timeout("8 seconds"),
  Effect.mapError((failure) =>
    failure instanceof ReleaseSmokeFailed || failure instanceof CandidateRoutingPending
      ? failure
      : new ReleaseSmokeFailed({
          reason: Cause.isTimeoutError(failure)
            ? "Smoke request exceeded its total deadline"
            : "Smoke exchange unavailable",
        })
  ),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
);

/** Closed diagnostics expose comparisons, not newly observed identities or provider text. */
const smokeDiagnostic = (response: SmokeExchange, expectedPublic: SmokeIdentity): string => {
  let versionState = "other";
  if (Option.isNone(response.publicVersion)) versionState = "missing";
  else if (response.publicVersion.value === expectedPublic.workerVersionId) {
    versionState = "expected";
  }
  const identityDetail =
    Option.contains(response.failureStage, "identity") && Option.isSome(response.equality)
      ? `, coreVersion=${response.equality.value[0] === "1"}, coreRevision=${response.equality.value[1] === "1"}, coreDigest=${response.equality.value[2] === "1"}`
      : "";
  const detail = Option.match(response.failureStage, {
    onNone: () => "",
    onSome: (stage) => `, stage=${stage}${identityDetail}`,
  });
  return `Candidate smoke response rejected (status=${response.status}, version=${versionState}, noStore=${response.noStore}${detail})`;
};
const isRoutingFallback = (response: SmokeExchange, expectedPublic: SmokeIdentity): boolean =>
  response.status >= successStart &&
  response.status < successEnd &&
  response.noStore &&
  Option.isSome(response.publicVersion) &&
  response.publicVersion.value !== expectedPublic.workerVersionId;
const isIdentityRefusal = (response: SmokeExchange, expectedPublic: SmokeIdentity): boolean =>
  response.status === refusedStatus &&
  response.noStore &&
  Option.contains(response.failureStage, "identity") &&
  Option.contains(response.publicVersion, expectedPublic.workerVersionId);
const publicAccepted = (response: SmokeExchange, expectedPublic: SmokeIdentity): boolean =>
  response.status >= successStart &&
  response.status < successEnd &&
  response.noStore &&
  Option.contains(response.publicVersion, expectedPublic.workerVersionId);

/** Classifies only pre-admission routing evidence as replayable. The runner decides whether and how to retry. */
export const checkSmokeExchange = Effect.fn(function* (
  response: SmokeExchange,
  expected: Readonly<{
    public: SmokeIdentity;
    core: SmokeIdentity;
    replayIdentity: boolean;
  }>
) {
  if (
    isRoutingFallback(response, expected.public) ||
    (expected.replayIdentity && isIdentityRefusal(response, expected.public))
  ) {
    return yield* new CandidateRoutingPending({
      reason: smokeDiagnostic(response, expected.public),
    });
  }
  if (!publicAccepted(response, expected.public)) {
    return yield* new ReleaseSmokeFailed({ reason: smokeDiagnostic(response, expected.public) });
  }
  const result = response.result;
  if (Option.isNone(result)) {
    return yield* new ReleaseSmokeFailed({
      reason: "Smoke response did not match the owned schema",
    });
  }
  if (
    !verifySmokeIdentity({ expected: expected.public, observed: result.value.public }) ||
    !verifySmokeIdentity({ expected: expected.core, observed: result.value.core })
  ) {
    return yield* new ReleaseSmokeFailed({
      reason: `Smoke identity mismatch (publicVersion=${result.value.public.workerVersionId === expected.public.workerVersionId}, publicRevision=${result.value.public.gitRevision === expected.public.gitRevision}, publicDigest=${result.value.public.contractDigest === expected.public.contractDigest}, coreVersion=${result.value.core.workerVersionId === expected.core.workerVersionId}, coreRevision=${result.value.core.gitRevision === expected.core.gitRevision}, coreDigest=${result.value.core.contractDigest === expected.core.contractDigest})`,
    });
  }
  return result.value.status;
});

type CoreObservation = Readonly<{
  version: Option.Option<string>;
  source: "body" | "header" | "equality" | "unavailable";
}>;
const rejectedCore = (response: SmokeExchange, stableCore: string): CoreObservation => {
  if (response.status === refusedStatus && Option.contains(response.failureStage, "identity")) {
    if (Option.isSome(response.coreVersion)) {
      return { version: response.coreVersion, source: "header" };
    }
    if (Option.isSome(response.equality) && response.equality.value[0] === "1") {
      return { version: Option.some(stableCore), source: "equality" };
    }
  }
  return { version: Option.none(), source: "unavailable" };
};
/** Diagnosis may name only validated protocol identities; equality fallback names the supplied stable Core, never a guess. */
export const observeSmokeCore = ({
  response,
  method,
  stableCore,
}: Readonly<{
  response: SmokeExchange;
  method: "GET" | "POST";
  stableCore: string;
}>): CoreObservation => {
  if (method === "GET" && response.status === successStart) {
    const version = Option.map(response.result, (value) => value.core.workerVersionId);
    return { version, source: Option.isSome(version) ? "body" : "unavailable" };
  }
  if (method === "POST") return rejectedCore(response, stableCore);
  return { version: Option.none(), source: "unavailable" };
};
