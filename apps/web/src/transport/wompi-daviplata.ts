import { Clock, Data, Effect, Option, Redacted, Schema } from "effect";
import { type DaviplataOtpPolicy } from "./client";
import { UnknownJsonString, jsonStringSchema } from "@/schema-compatibility";
import {
  type WompiFetch,
  readBoundedWompiResponse,
  wompiTokenizationOrigin,
} from "./wompi-tokenization";

export class DaviplataAuthorizationFailed extends Data.TaggedError(
  "DaviplataAuthorizationFailed"
)<{}> {}
const failure = (): DaviplataAuthorizationFailed => new DaviplataAuthorizationFailed();
const maximumSecretLength = 4096;
const maximumUrlLength = 2048;
const maximumRequestBytes = 8192;
const maximumLifetimeMilliseconds = 300_000;
const maximumSends = 2;
const maximumValidations = 2;
const SecretText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumSecretLength)
);
const TokenId = Schema.String.check(
  Schema.isPattern(/^daviplata_(?:devtest|devint|prod)_[A-Za-z0-9_]+$/u),
  Schema.isMaxLength(maximumSecretLength)
);
const InitialResponse = Schema.Struct({
  data: Schema.Struct({
    id: TokenId,
    status: Schema.Literal("PENDING"),
    url_services: Schema.Struct({
      token: SecretText,
      code_otp_send: Schema.String,
      code_otp_validate: Schema.String,
    }),
  }),
});
const Counter = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const OtpResponse = Schema.Struct({
  data: Schema.Struct({
    subscription: Schema.Struct({
      PK: TokenId,
      status: Schema.Literals(["PENDING", "APPROVED", "DECLINED"]),
    }),
    authorization: Schema.Struct({ access_token: SecretText }),
    attempts: Schema.Struct({
      currentSendCode: Counter,
      limitSendCode: Counter,
      currentValidateCode: Counter,
      limitValidateCode: Counter,
    }),
  }),
});
const DocumentNumber = Schema.String.check(Schema.isPattern(/^[0-9]{5,15}$/u));
const ProductNumber = Schema.String.check(Schema.isPattern(/^3[0-9]{9}$/u));
const OtpCode = Schema.String.check(Schema.isPattern(/^[0-9]{6}$/u));
const encodeInitial = Schema.encodeEffect(
  jsonStringSchema(
    Schema.Struct({
      type_document: Schema.Literal("CC"),
      number_document: DocumentNumber,
      product_number: ProductNumber,
    })
  )
);
const encodeOtp = Schema.encodeEffect(jsonStringSchema(Schema.Struct({ code: OtpCode })));

/** Only CC is supported by the documented recurring-authorization example. */
export type DaviplataFields = Readonly<{
  documentNumber: Redacted.Redacted<string>;
  productNumber: Redacted.Redacted<string>;
}>;
export type DaviplataProviderOutcome =
  | Readonly<{ status: "retry-allowed" }>
  | Readonly<{ status: "approved"; token: Redacted.Redacted<string> }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "uncertain" }>;
/** Provider authority stays enclosed; only the enrollment gateway may consume an approved token. */
export type DaviplataProviderChallenge = Readonly<{
  resend: () => Effect.Effect<DaviplataProviderOutcome>;
  confirm: (otp: Redacted.Redacted<string>) => Effect.Effect<DaviplataProviderOutcome>;
  retrySubmission: () => Effect.Effect<DaviplataProviderOutcome>;
  dispose: () => void;
}>;

const checkEndpoint = (
  url: string,
  origin: string
): Effect.Effect<void, DaviplataAuthorizationFailed> =>
  Effect.try({
    try: () => {
      const parsed = new URL(url);
      const clean = `${parsed.username}${parsed.password}${parsed.search}${parsed.hash}` === "";
      if (
        !clean ||
        url.length > maximumUrlLength ||
        parsed.origin !== origin ||
        parsed.port !== "" ||
        parsed.href !== url
      ) {
        throw failure();
      }
    },
    catch: failure,
  });
const awaitAbort = (signal: AbortSignal): Effect.Effect<never, DaviplataAuthorizationFailed> =>
  Effect.callback((resume) => {
    const abort = (): void => resume(Effect.fail(failure()));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
type OtpRequest<Decoder extends Schema.ConstraintDecoder<unknown>> = Readonly<{
  publicKey: string;
  approvedUrl: string;
  providerUrl: unknown;
  authorization: Redacted.Redacted<string>;
  body: Option.Option<Redacted.Redacted<string>>;
  responseSchema: Decoder;
  fetchImplementation: WompiFetch;
  signal: AbortSignal;
}>;

/** Consumes one bearer/payload. Exact destination, bounded bytes/time, cancellation; no retries or telemetry. */
export const postDaviplataOtp = <Decoder extends Schema.ConstraintDecoder<unknown>>(
  input: OtpRequest<Decoder>
): Effect.Effect<Decoder["Type"], DaviplataAuthorizationFailed, Decoder["DecodingServices"]> => {
  const request = Effect.gen(function* () {
    const origin = yield* wompiTokenizationOrigin(input.publicKey).pipe(Effect.mapError(failure));
    yield* checkEndpoint(input.approvedUrl, origin);
    const url = yield* Schema.decodeUnknownEffect(Schema.Literal(input.approvedUrl))(
      input.providerUrl
    ).pipe(Effect.mapError(failure));
    if (
      Option.isSome(input.body) &&
      new TextEncoder().encode(Redacted.value(input.body.value)).byteLength > maximumRequestBytes
    ) {
      return yield* failure();
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        input.fetchImplementation(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${Redacted.value(input.authorization)}`,
            "content-type": "application/json",
          },
          ...Option.match(input.body, {
            onNone: () => ({}),
            onSome: (body) => ({ body: Redacted.value(body) }),
          }),
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.any([signal, input.signal]),
        }),
      catch: failure,
    });
    const text = yield* readBoundedWompiResponse(response).pipe(Effect.mapError(failure));
    if (!response.ok || response.redirected) return yield* failure();
    const json = yield* Schema.decodeEffect(UnknownJsonString)(text).pipe(Effect.mapError(failure));
    return yield* Schema.decodeUnknownEffect(input.responseSchema)(json).pipe(
      Effect.mapError(failure)
    );
  });
  return Effect.raceFirst(request, awaitAbort(input.signal)).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(failure),
    Effect.ensuring(
      Effect.sync(() => {
        Redacted.wipeUnsafe(input.authorization);
        Option.map(input.body, Redacted.wipeUnsafe);
      })
    )
  );
};
type AuthorizationInput = Readonly<{
  publicKey: string;
  policy: DaviplataOtpPolicy;
  fields: DaviplataFields;
  fetchImplementation: WompiFetch;
  signal: AbortSignal;
  expiresAt: number;
}>;
type Authority = Readonly<{
  input: AuthorizationInput;
  deadline: number;
  signal: AbortSignal;
  dispose: () => void;
  state: {
    bearer: Option.Option<Redacted.Redacted<string>>;
    token: Option.Option<Redacted.Redacted<string>>;
    disposed: boolean;
    busy: boolean;
    sends: number;
    validates: number;
    sendLimit: number;
    validateLimit: number;
    approved: boolean;
    usedBearers: Array<Redacted.Redacted<string>>;
  };
}>;
const makeAuthority = (
  input: AuthorizationInput,
  timing: Readonly<{ deadline: number; now: number; clock: Clock.Clock }>
): Authority => {
  const { deadline, now, clock } = timing;
  const controller = new AbortController();
  const state = {
    bearer: Option.none<Redacted.Redacted<string>>(),
    token: Option.none<Redacted.Redacted<string>>(),
    disposed: false,
    busy: false,
    sends: 0,
    validates: 0,
    sendLimit: maximumSends,
    validateLimit: maximumValidations,
    approved: false,
    usedBearers: [],
  };
  const dispose = (): void => {
    state.disposed = true;
    controller.abort();
    Option.map(state.bearer, Redacted.wipeUnsafe);
    Option.map(state.token, Redacted.wipeUnsafe);
    state.usedBearers.forEach(Redacted.wipeUnsafe);
    state.usedBearers.length = 0;
    state.bearer = Option.none();
    state.token = Option.none();
    timer.interruptUnsafe();
    input.signal.removeEventListener("abort", dispose);
  };
  const timer = Effect.runFork(
    Effect.sleep(deadline - now).pipe(
      Effect.tap(() => Effect.sync(dispose)),
      Effect.provideService(Clock.Clock, clock)
    )
  );
  input.signal.addEventListener("abort", dispose, { once: true });
  return {
    input,
    deadline,
    state,
    signal: AbortSignal.any([controller.signal, input.signal]),
    dispose,
  };
};
type Action =
  | Readonly<{ type: "send" }>
  | Readonly<{ type: "confirm"; otp: Redacted.Redacted<string> }>;
const applyResponse = (
  authority: Authority,
  data: typeof OtpResponse.Type.data,
  action: Action
): Effect.Effect<DaviplataProviderOutcome, DaviplataAuthorizationFailed> => {
  const { state, dispose } = authority;
  if (Option.isNone(state.token) || data.subscription.PK !== Redacted.value(state.token.value)) {
    return Effect.fail(failure());
  }
  state.sendLimit = Math.min(state.sendLimit, data.attempts.limitSendCode);
  state.validateLimit = Math.min(state.validateLimit, data.attempts.limitValidateCode);
  state.sends = Math.max(state.sends, data.attempts.currentSendCode);
  state.validates = Math.max(state.validates, data.attempts.currentValidateCode);
  if (data.subscription.status === "DECLINED") {
    dispose();
    return Effect.succeed({ status: "refused" });
  }
  if (data.subscription.status === "APPROVED") {
    if (action.type !== "confirm") return Effect.fail(failure());
    state.approved = true;
    return Effect.succeed({ status: "approved", token: state.token.value });
  }
  if (state.usedBearers.some((used) => Redacted.value(used) === data.authorization.access_token)) {
    return Effect.fail(failure());
  }
  state.bearer = Option.some(Redacted.make(data.authorization.access_token));
  return Effect.succeed({ status: "retry-allowed" });
};
const actionAllowed = (authority: Authority, action: Action): boolean =>
  action.type === "send"
    ? authority.state.sends < authority.state.sendLimit
    : authority.state.validates < authority.state.validateLimit;
const sendAction = (
  authority: Authority,
  action: Action
): Effect.Effect<DaviplataProviderOutcome, DaviplataAuthorizationFailed> =>
  Effect.gen(function* () {
    const { state, input } = authority;
    if (Option.isNone(state.bearer)) return { status: "refused" } as const;
    const body =
      action.type === "send"
        ? Option.none<Redacted.Redacted<string>>()
        : Option.some(
            Redacted.make(
              yield* encodeOtp({ code: Redacted.value(action.otp) }).pipe(Effect.mapError(failure))
            )
          );
    const authorization = state.bearer.value;
    state.usedBearers.push(Redacted.make(Redacted.value(authorization)));
    state.bearer = Option.none();
    state.busy = true;
    if (action.type === "send") state.sends += 1;
    else state.validates += 1;
    const url = action.type === "send" ? input.policy.sendUrl : input.policy.confirmUrl;
    const response = yield* postDaviplataOtp({
      publicKey: input.publicKey,
      approvedUrl: url,
      providerUrl: url,
      authorization,
      body,
      responseSchema: OtpResponse,
      fetchImplementation: input.fetchImplementation,
      signal: authority.signal,
    });
    return yield* applyResponse(authority, response.data, action);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        authority.state.busy = false;
      })
    )
  );
const perform = (authority: Authority, action: Action): Effect.Effect<DaviplataProviderOutcome> =>
  Effect.gen(function* () {
    const { state } = authority;
    const now = yield* Clock.currentTimeMillis;
    if (state.disposed || now >= authority.deadline) {
      authority.dispose();
      return { status: "refused" } as const;
    }
    if (state.busy) return { status: "retry-allowed" } as const;
    if (state.approved) return { status: "refused" } as const;
    if (!actionAllowed(authority, action)) return { status: "refused" } as const;
    return yield* sendAction(authority, action);
  }).pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        authority.dispose();
        return { status: "uncertain" } as const;
      })
    ),
    Effect.onInterrupt(() => Effect.sync(authority.dispose)),
    Effect.ensuring(
      Effect.sync(() => {
        if (action.type === "confirm") Redacted.wipeUnsafe(action.otp);
      })
    )
  );
const initialize = (
  authority: Authority,
  origin: string
): Effect.Effect<void, DaviplataAuthorizationFailed> =>
  Effect.gen(function* () {
    const { input, state } = authority;
    const body = yield* encodeInitial({
      type_document: "CC",
      number_document: Redacted.value(input.fields.documentNumber),
      product_number: Redacted.value(input.fields.productNumber),
    }).pipe(Effect.mapError(failure));
    const url = `${origin}/v1/tokens/daviplata`;
    const response = yield* postDaviplataOtp({
      publicKey: input.publicKey,
      approvedUrl: url,
      providerUrl: url,
      authorization: Redacted.make(input.publicKey),
      body: Option.some(Redacted.make(body)),
      responseSchema: InitialResponse,
      fetchImplementation: input.fetchImplementation,
      signal: authority.signal,
    });
    const data = response.data;
    const prefix = input.publicKey.startsWith("pub_prod_") ? "daviplata_prod_" : "daviplata_dev";
    if (
      !data.id.startsWith(prefix) ||
      data.url_services.code_otp_send !== input.policy.sendUrl ||
      data.url_services.code_otp_validate !== input.policy.confirmUrl
    ) {
      return yield* failure();
    }
    state.token = Option.some(Redacted.make(data.id));
    state.bearer = Option.some(Redacted.make(data.url_services.token));
    const first = yield* perform(authority, { type: "send" });
    if (first.status === "uncertain" || first.status === "refused") return yield* failure();
  });
/**
 * Tokenizes CC/product fields directly and sends the first OTP. Actions consume rotating bearers
 * within an absolute five-minute/enrollment deadline. Disposal/cancellation revoke the closure.
 * Ambiguous mutations stop authorization permanently; OTPs are never retried automatically.
 */
export const startDaviplataWithWompi = (
  input: AuthorizationInput
): Effect.Effect<DaviplataProviderChallenge, DaviplataAuthorizationFailed> =>
  Effect.gen(function* () {
    const origin = yield* wompiTokenizationOrigin(input.publicKey).pipe(Effect.mapError(failure));
    yield* checkEndpoint(input.policy.sendUrl, origin);
    yield* checkEndpoint(input.policy.confirmUrl, origin);
    const now = yield* Clock.currentTimeMillis;
    const deadline = Math.min(input.expiresAt, now + maximumLifetimeMilliseconds);
    if (!Number.isFinite(deadline) || deadline <= now || input.signal.aborted) {
      return yield* failure();
    }
    const authority = makeAuthority(input, { deadline, now, clock: yield* Clock.Clock });
    yield* initialize(authority, origin).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" ? Effect.sync(authority.dispose) : Effect.void
      )
    );
    return {
      resend: () => perform(authority, { type: "send" }),
      confirm: (otp: Redacted.Redacted<string>) => perform(authority, { type: "confirm", otp }),
      retrySubmission: () =>
        Effect.gen(function* () {
          const retryNow = yield* Clock.currentTimeMillis;
          if (authority.state.disposed || retryNow >= authority.deadline) {
            authority.dispose();
            return { status: "refused" } as const;
          }
          return authority.state.approved && Option.isSome(authority.state.token)
            ? ({ status: "approved", token: authority.state.token.value } as const)
            : ({ status: "refused" } as const);
        }),
      dispose: authority.dispose,
    };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        Redacted.wipeUnsafe(input.fields.documentNumber);
        Redacted.wipeUnsafe(input.fields.productNumber);
      })
    )
  );
