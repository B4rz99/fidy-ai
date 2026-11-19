import { installedOrigins } from "../../src/shell/browser-transport/contract";
import { browserOrigins } from "../runtime/contract";
import { Clock, Effect, Option, Schema } from "effect";
import {
  type AcceptanceBoundary,
  type AcceptanceEnvironment,
  type AcceptanceWindowBindings,
  type NativeAcceptanceSettings,
  acceptanceApiHeader,
  acceptanceLifetimeMs,
  acceptanceReceiptKind,
  acceptanceWindowQuery,
} from "./contract";
import { scopedDeadline, signRequest, verifyRequest } from "./internal/request-proof";
import { deploymentPhase } from "./internal/deployment";
import { smokePath, smokeProofAccepted } from "../runtime/release-smoke/contract";

type Environment = Readonly<{ mode: Option.Option<string>; proof: Option.Option<string> }>;
const unavailableStatus = 503;
const isolatedResponse = (): Response =>
  Response.json(
    { status: "unavailable" },
    {
      status: unavailableStatus,
      headers: { "cache-control": "no-store", "x-fidy-recovery-isolation": "isolated" },
    }
  );
const recoveryProbeAllowed = (request: Request, environment: Environment): boolean => {
  const path = new URL(request.url).pathname;
  if (path === "/health") return request.method === "GET";
  return (
    path === smokePath &&
    smokeProofAccepted({ request, secret: Option.getOrElse(environment.proof, () => "") })
  );
};

/** Both HTTP boundaries deny ordinary admission while recovery routing propagates. */
export const recoveryIsolationResponse = ({
  request,
  environment,
}: Readonly<{
  request: Request;
  environment: Environment;
}>): Option.Option<Response> => {
  const mode = Option.getOrElse(environment.mode, () => "");
  if (mode === "") return Option.none();
  if (mode === "isolated" && recoveryProbeAllowed(request, environment)) return Option.none();
  return Option.some(isolatedResponse());
};

/** The protected runner signs an exact browser or client request; Ingress separately signs its transformed private request. */
export const signAcceptanceRequest: typeof signRequest = (input) => signRequest(input);
export const acceptanceRequestAdmitted: typeof verifyRequest = (input) => verifyRequest(input);

/** Ingress selects the browser pair from its TLS endpoint; Core reads only the value the scoped private request signs. */
export const closedHostEnvironment = <
  Environment extends NativeAcceptanceSettings & { BROWSER_ORIGIN: string },
>({
  request,
  environment,
  boundary,
}: {
  request: Request;
  environment: Environment;
  boundary: AcceptanceBoundary;
}): Environment => {
  if (deploymentPhase(environment) !== "closed") return environment;
  const api =
    boundary === "ingress" ? new URL(request.url).origin : request.headers.get(acceptanceApiHeader);
  const pair = Object.values(installedOrigins).find((item) => item.api === api);
  if (pair === undefined) return environment;
  return {
    ...environment,
    BROWSER_ORIGIN: pair.browser,
    GOOGLE_REDIRECT_URI: pair.api + "/providers/google/callback",
    MICROSOFT_REDIRECT_URI: pair.api + "/providers/microsoft/callback",
  };
};
const liveAddress = (
  request: Request,
  environment: AcceptanceEnvironment,
  boundary: AcceptanceBoundary
): boolean => {
  const origin = new URL(request.url).origin;
  if (boundary === "core") return true;
  if (environment.BROWSER_ORIGIN === browserOrigins.local) {
    return ["http://127.0.0.1:8787", "http://localhost:8787"].includes(origin);
  }
  return (
    environment.BROWSER_ORIGIN === installedOrigins.production.browser &&
    origin === installedOrigins.production.api
  );
};
export const isAcceptanceWindow = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "POST" && url.pathname === smokePath && url.search === acceptanceWindowQuery
  );
};
export const releaseAdmission = Effect.fn(function* (
  request: Request,
  environment: AcceptanceEnvironment,
  boundary: AcceptanceBoundary
) {
  const phase = deploymentPhase(environment);
  if (phase === "invalid" || (phase === "open" && !liveAddress(request, environment, boundary))) {
    return { denial: Option.some(isolatedResponse()), deadline: Option.none<number>() };
  }
  const blocked = recoveryIsolationResponse({
    request,
    environment: {
      mode: Option.fromUndefinedOr(environment.RECOVERY_ISOLATION),
      proof: Option.fromUndefinedOr(environment.SMOKE_PROOF),
    },
  });
  if (Option.isNone(blocked)) return { denial: blocked, deadline: Option.none<number>() };
  if (
    yield* verifyRequest({ request, environment, boundary, now: yield* Clock.currentTimeMillis })
  ) {
    return { denial: Option.none<Response>(), deadline: scopedDeadline(request) };
  }
  return { denial: blocked, deadline: Option.none<number>() };
});

const cohortLimits = { smoke: 2, erasure: 1, performance: 20, fleet: 1000 } as const;
const syntheticSubject =
  /^fidy-acceptance-([a-f0-9]{40})-(smoke|erasure|performance|fleet)-([1-9][0-9]{0,3})$/u;
const fixtureConsumerIssuer =
  "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0";
/** The verified provider registration carries the bounded synthetic identity through normal authorization. */
export const acceptanceSubject = ({
  revision,
  issuer,
  subject,
}: {
  revision: string;
  issuer: string;
  subject: string;
}): boolean => {
  if (issuer !== "https://accounts.google.com" && issuer !== fixtureConsumerIssuer) return false;
  const match = syntheticSubject.exec(subject);
  if (match === null || match[1] !== revision) return false;
  const purpose = match[2],
    ordinal = Number(match[3]);
  return (
    (purpose === "smoke" ||
      purpose === "erasure" ||
      purpose === "performance" ||
      purpose === "fleet") &&
    ordinal <= cohortLimits[purpose]
  );
};

const windowKey = (revision: string): string => `_release-smoke/${revision}/acceptance/work`;
const Window = Schema.Struct({ revision: Schema.String, deadline: Schema.Int });
export const renewAcceptanceWindow = Effect.fn(function* (
  request: Request,
  settings: AcceptanceWindowBindings & Partial<Readonly<{ SMOKE_PROOF: string }>>
) {
  const revision = settings.RELEASE_GIT_SHA ?? "",
    bucket = settings.SMOKE_BUCKET;
  if (
    settings.NATIVE_STORAGE_ADMISSION !== "closed" ||
    settings.RECOVERY_ISOLATION !== "isolated" ||
    bucket === undefined ||
    !smokeProofAccepted({ request, secret: settings.SMOKE_PROOF ?? "" }) ||
    !/^[a-f0-9]{40}$/u.test(revision)
  ) {
    return isolatedResponse();
  }
  const data = { revision, deadline: (yield* Clock.currentTimeMillis) + acceptanceLifetimeMs },
    body = yield* Schema.encodeEffect(Schema.fromJsonString(Window))(data);
  yield* Effect.tryPromise(() => bucket.put(windowKey(revision), body));
  return Response.json(data, { headers: { "cache-control": "no-store" } });
});
/** Normal release execution remains unchanged. A private runner must renew a closed test's short window before background work can advance. */
const validMarker = (value: typeof Window.Type, revision: string, now: number): boolean =>
  value.revision === revision &&
  value.deadline > now &&
  value.deadline <= now + acceptanceLifetimeMs;
export const backgroundWorkAllowed = Effect.fn(
  function* (settings: AcceptanceWindowBindings) {
    const phase = deploymentPhase(settings);
    if (phase === "normal" || phase === "open") return true;
    const revision = settings.RELEASE_GIT_SHA ?? "",
      bucket = settings.SMOKE_BUCKET;
    if (phase !== "closed" || bucket === undefined || !/^[a-f0-9]{40}$/u.test(revision)) {
      return false;
    }
    const marker = yield* Effect.tryPromise(() => bucket.get(windowKey(revision)));
    if (marker === null) return false;
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(Window))(
        yield* Effect.tryPromise(() => marker.text())
      ),
      now = yield* Clock.currentTimeMillis;
    return validMarker(value, revision, now);
  },
  Effect.orElseSucceed(() => false)
);

export const isAcceptanceReceipt = (request: Request): boolean => {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    url.pathname === smokePath &&
    url.searchParams.get("acceptance") === acceptanceReceiptKind
  );
};
const receipt = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^fidy-[a-f0-9]{32}$/u)),
  reference: Schema.String.check(
    Schema.isPattern(/^fidy-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
  ),
  finalizedAt: Schema.String,
});
/** Return the immutable charge coordinates for this synthetic provider account after its POST reply was lost. */
export const fixtureChargeReceipt = Effect.fn(function* (
  request: Request,
  settings: AcceptanceWindowBindings & Partial<Readonly<{ SMOKE_PROOF: string }>>
) {
  if (
    deploymentPhase(settings) !== "closed" ||
    !smokeProofAccepted({ request, secret: settings.SMOKE_PROOF ?? "" }) ||
    settings.SMOKE_BUCKET === undefined
  ) {
    return isolatedResponse();
  }
  const revision = settings.RELEASE_GIT_SHA ?? "",
    params = new URL(request.url).searchParams;
  const subject = `fidy-acceptance-${revision}-${params.get("cohort")}-${params.get("ordinal")}`;
  if (!acceptanceSubject({ revision, issuer: "https://accounts.google.com", subject })) {
    return new Response(null, { status: 404 });
  }
  const bucket = settings.SMOKE_BUCKET;
  const stored = yield* Effect.tryPromise(() =>
    bucket.get(`_release-smoke/${revision}/acceptance/wompi/first-charge/${subject}@example.test`)
  );
  if (stored === null) return new Response(null, { status: 404 });
  const data = yield* Schema.decodeUnknownEffect(receipt)(
    yield* Effect.tryPromise(() => stored.json())
  );
  return Response.json(data, { headers: { "cache-control": "no-store" } });
});
