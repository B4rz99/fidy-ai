import { Effect, Option, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { installedOrigins } from "../../../src/shell/browser-transport/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { digestBytes } from "../../secret-material/operations";
import {
  type AcceptanceBoundary,
  type AcceptanceEnvironment,
  AcceptanceProofUnavailable,
  acceptanceApiHeader,
  acceptanceLifetimeMs,
  acceptanceProofHeader,
} from "../contract";

type Context = {
  request: Request;
  boundary: AcceptanceBoundary;
  environment: AcceptanceEnvironment;
};

const proofValue = (request: Request): string => request.headers.get(acceptanceProofHeader) ?? "";

const proof = /^(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})$/u,
  revision = /^[a-f0-9]{40}$/u;

const minimumKeyLength = 32;

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 6_000_000,
  deadlineMilliseconds: 8_000,
});

const relevantHeaders = [
  acceptanceApiHeader,
  "authorization",
  "cookie",
  "origin",
  "content-type",
  "if-match",
  "idempotency-key",
  "fidy-session-binding",
  "fidy-idempotency-key",
  "cf-access-jwt-assertion",
  "x-event-checksum",
  "x-webhook-event",
  "x-webhook-signature",
  "x-idempotency-key",
  "x-provider-source",
  "x-oauth-source",
  "x-pat-source",
  "x-canonical-source",
  "x-forwarded-host",
  "mcp-protocol-version",
  "mcp-session-id",
  "access-control-request-method",
  "access-control-request-headers",
] as const;

const eligible = ({ request, boundary, environment }: Context): boolean => {
  if (
    environment.RECOVERY_ISOLATION !== "isolated" ||
    environment.NATIVE_STORAGE_ADMISSION !== "closed" ||
    !revision.test(environment.RELEASE_GIT_SHA) ||
    (environment.SMOKE_PROOF ?? "").length < minimumKeyLength
  ) {
    return false;
  }

  const { origin } = new URL(request.url);

  return boundary === "core"
    ? origin === "https://core.internal"
    : Object.values(installedOrigins).some(
        (pair) => pair.browser === environment.BROWSER_ORIGIN && pair.api === origin
      );
};

const bodyDigest = Effect.fn(function* (request: Request) {
  const clone = yield* Effect.try(() => request.clone());

  return Hex.encode(yield* digestBytes(yield* readBoundedRequestBody(clone, policy)));
});

const signedContent = Effect.fn(function* (
  { request, boundary, environment }: Context,
  deadline: number,
  digest: string
) {
  const fields = [
    "fidy-native-acceptance-v1",
    boundary,
    environment.RELEASE_GIT_SHA,
    environment.BROWSER_ORIGIN,
    String(deadline),
    request.method,
    request.url,
    digest,
    ...relevantHeaders.map((header) => request.headers.get(header) ?? ""),
  ];

  const content = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
    fields
  );

  return new TextEncoder().encode(content);
});

const key = (environment: AcceptanceEnvironment): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(environment.SMOKE_PROOF ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

export const signRequest = Effect.fn(function* (ctx: Context & { deadline: number }) {
  if (!eligible(ctx) || !Number.isSafeInteger(ctx.deadline)) {
    return yield* new AcceptanceProofUnavailable();
  }

  const digest = yield* bodyDigest(ctx.request),
    content = yield* signedContent(ctx, ctx.deadline, digest),
    credential = yield* Effect.tryPromise(() => key(ctx.environment));

  const mac = yield* Effect.tryPromise(() => crypto.subtle.sign("HMAC", credential, content));

  return [String(ctx.deadline), digest, Hex.encode(new Uint8Array(mac))].join(".");
});

const windowValid = (deadline: number, now: number): boolean =>
  deadline > now && deadline <= now + acceptanceLifetimeMs;

const authenticatedDigest = Effect.fn(function* (ctx: Context & { now: number }) {
  const pieces = proof.exec(proofValue(ctx.request));

  if (pieces === null || !eligible(ctx)) return Option.none<string>();
  const [, time, digest = "", signature = ""] = pieces;
  const deadline = Number(time);

  if (!windowValid(deadline, ctx.now)) return Option.none<string>();
  const mac = Hex.decode(signature);

  if (Result.isFailure(mac)) return Option.none<string>();
  const credential = yield* Effect.tryPromise(() => key(ctx.environment));
  const content = yield* signedContent(ctx, deadline, digest);

  const authenticated = yield* Effect.tryPromise(() =>
    crypto.subtle.verify("HMAC", credential, Uint8Array.from(mac.success), content)
  );

  return authenticated ? Option.some(digest) : Option.none<string>();
});

const verifiedBody = Effect.fn(
  function* (ctx: Context & { now: number }, source: () => Pick<Request, "body" | "signal">) {
    const digest = yield* authenticatedDigest(ctx);

    if (Option.isNone(digest)) return Option.none<Uint8Array<ArrayBuffer>>();
    const bytes = yield* readBoundedRequestBody(yield* Effect.try(source), policy);

    return Hex.encode(yield* digestBytes(bytes)) === digest.value
      ? Option.some(bytes)
      : Option.none();
  },
  Effect.tapError(Effect.logDebug),
  Effect.orElseSucceed(() => Option.none<Uint8Array<ArrayBuffer>>())
);

export const verifyRequest = (ctx: Context & { now: number }): Effect.Effect<boolean> =>
  verifiedBody(ctx, () => ctx.request.clone()).pipe(Effect.map(Option.isSome));

export const verifiedCoreRequest = Effect.fn(function* (ctx: Context & { now: number }) {
  const body = yield* verifiedBody(ctx, () => ctx.request);

  return Option.map(body, (bytes) => {
    if (ctx.request.body === null) return ctx.request;
    const headers = new Headers(ctx.request.headers);
    headers.delete("transfer-encoding");
    headers.delete("content-length");

    return new Request(ctx.request, { method: ctx.request.method, headers, body: bytes });
  });
});

export const scopedDeadline = (request: Request): Option.Option<number> =>
  Option.fromNullishOr(proof.exec(request.headers.get(acceptanceProofHeader) ?? "")?.[1]).pipe(
    Option.map(Number)
  );
