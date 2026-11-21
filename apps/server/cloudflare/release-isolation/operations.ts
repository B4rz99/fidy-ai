import {
  performanceEvidenceAdmitted as admitsPerformanceEvidence,
  isPerformanceEvidence as matchesPerformanceEvidence,
  openTransactionReceipt as openReceipt,
  sealTransactionReceipt as sealReceipt,
  signPerformanceAccounting as signAccounting,
  verifyIssuedCapture as verifyCapture,
} from "./internal/performance-receipt";
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
  acceptanceProviderRevision,
  acceptanceReceiptKind,
  acceptanceWindowQuery,
} from "./contract";
import {
  scopedDeadline,
  signRequest,
  verifiedCoreRequest,
  verifyRequest,
} from "./internal/request-proof";
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

export const signAcceptanceRequest: typeof signRequest = (input) => signRequest(input);

export const acceptanceRequestAdmitted: typeof verifyRequest = (input) => verifyRequest(input);

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
    return { request, denial: Option.some(isolatedResponse()), deadline: Option.none<number>() };
  }

  const blocked = recoveryIsolationResponse({
    request,
    environment: {
      mode: Option.fromUndefinedOr(environment.RECOVERY_ISOLATION),
      proof: Option.fromUndefinedOr(environment.SMOKE_PROOF),
    },
  });

  if (Option.isNone(blocked)) return { request, denial: blocked, deadline: Option.none<number>() };
  const context = { request, environment, boundary, now: yield* Clock.currentTimeMillis };

  const admitted = yield* boundary === "core"
    ? verifiedCoreRequest(context)
    : verifyRequest(context).pipe(
        Effect.map((valid) => (valid ? Option.some(request) : Option.none()))
      );

  if (Option.isSome(admitted)) {
    return {
      request: admitted.value,
      denial: Option.none<Response>(),
      deadline: scopedDeadline(request),
    };
  }

  return { request, denial: blocked, deadline: Option.none<number>() };
});

const cohortLimits = new Map(
  Object.entries({
    smoke: 2,
    erasure: 1,
    performance: 20,
    fleet: 1000,
  })
);

const syntheticSubject =
  /^fidy-acceptance-([a-f0-9]{40})-(smoke|erasure|performance|fleet)-([1-9][0-9]{0,3})$/u;

const fixtureConsumerIssuer =
  "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0";

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

  const purpose = match[2] ?? "",
    ordinal = Number(match[3]);

  return ordinal <= (cohortLimits.get(purpose) ?? 0);
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
  Effect.tapError(Effect.logDebug),
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

  const revision = acceptanceProviderRevision(settings),
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

export const isPerformanceEvidence: typeof matchesPerformanceEvidence = (request) =>
  matchesPerformanceEvidence(request);

export const performanceEvidenceAdmitted: typeof admitsPerformanceEvidence = (input) =>
  admitsPerformanceEvidence(input);

export const sealTransactionReceipt: typeof sealReceipt = (input) => sealReceipt(input);

export const openTransactionReceipt: typeof openReceipt = (input) => openReceipt(input);

export const signPerformanceAccounting: typeof signAccounting = (...args) =>
  signAccounting(...args);

export const verifyIssuedCapture: typeof verifyCapture = (...args) => verifyCapture(...args);
