import { Data, Effect, Option, Redacted, Result, Schema } from "effect";
import { UnknownJsonString, jsonStringSchema } from "@/schema-compatibility";
import {
  type WompiFetch,
  readBoundedWompiResponse,
  wompiTokenizationOrigin,
} from "./wompi-tokenization";

export class NequiAuthorizationFailed extends Data.TaggedError("NequiAuthorizationFailed")<{}> {}
const maximumTokenCharacters = 4096;
const maximumApprovalChecks = 100;
const TokenResponse = Schema.Struct({
  data: Schema.Struct({
    id: Schema.String.check(
      Schema.isPattern(/^nequi_(?:test|prod)_[A-Za-z0-9_-]+$/u),
      Schema.isMaxLength(maximumTokenCharacters)
    ),
    status: Schema.Literals(["PENDING", "APPROVED", "DECLINED", "ERROR"]),
  }),
});
const PhoneNumber = Schema.String.check(Schema.isPattern(/^3[0-9]{9}$/u));
const NequiRequest = jsonStringSchema(Schema.Struct({ phone_number: PhoneNumber }));
const decodeJson = Schema.decodeUnknownResult(UnknownJsonString);
const decodeToken = Schema.decodeUnknownResult(TokenResponse);
const failure = (): NequiAuthorizationFailed => new NequiAuthorizationFailed();

const requestToken = (
  input: Readonly<{
    url: string;
    publicKey: string;
    fetch: WompiFetch;
    body: Option.Option<string>;
  }>
): Effect.Effect<
  Readonly<{ token: Redacted.Redacted<string>; status: typeof TokenResponse.Type.data.status }>,
  NequiAuthorizationFailed
> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        input.fetch(input.url, {
          method: Option.isNone(input.body) ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${input.publicKey}`,
            "content-type": "application/json",
          },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          signal,
          ...(Option.isNone(input.body) ? {} : { body: input.body.value }),
        }),
      catch: failure,
    });
    if (!response.ok) {
      const body = response.body;
      if (body !== null) {
        yield* Effect.tryPromise({ try: () => body.cancel(), catch: failure }).pipe(Effect.ignore);
      }
      return yield* failure();
    }
    const text = yield* readBoundedWompiResponse(response).pipe(Effect.mapError(failure));
    const json = decodeJson(text);
    if (Result.isFailure(json)) return yield* failure();
    const decoded = decodeToken(json.success);
    if (Result.isFailure(decoded)) return yield* failure();
    return { token: Redacted.make(decoded.success.data.id), status: decoded.success.data.status };
  }).pipe(Effect.timeout("15 seconds"), Effect.mapError(failure));

type NequiAuthorizationInput = Readonly<{
  publicKey: string;
  phoneNumber: Redacted.Redacted<string>;
  fetch: WompiFetch;
  onAwaiting: () => void;
}>;

const initiateAuthorization = (
  input: NequiAuthorizationInput,
  origin: string
): ReturnType<typeof requestToken> =>
  Effect.gen(function* () {
    const phone = yield* Schema.decodeEffect(PhoneNumber)(Redacted.value(input.phoneNumber)).pipe(
      Effect.mapError(failure)
    );
    return yield* requestToken({
      url: `${origin}/v1/tokens/nequi`,
      publicKey: input.publicKey,
      fetch: input.fetch,
      body: Option.some(
        yield* Schema.encodeEffect(NequiRequest)({ phone_number: phone }).pipe(
          Effect.mapError(failure)
        )
      ),
    });
  }).pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(input.phoneNumber))));

/**
 * Sends the Nequi number only to Wompi, then waits within five minutes for app approval.
 * The callback clears the caller's number and displays the approval stage after tokenization.
 * Cancellation aborts requests and owned readers. The returned token is transient submission
 * material: never persist it, expose it in a navigation URL, or put it into shared state.
 */
export const authorizeNequiWithWompi = (
  input: NequiAuthorizationInput
): Effect.Effect<Redacted.Redacted<string>, NequiAuthorizationFailed> =>
  Effect.gen(function* () {
    const origin = yield* wompiTokenizationOrigin(input.publicKey).pipe(Effect.mapError(failure));
    let current = yield* initiateAuthorization(input, origin);
    const prefix = input.publicKey.startsWith("pub_test_") ? "nequi_test_" : "nequi_prod_";
    if (!Redacted.value(current.token).startsWith(prefix)) return yield* failure();
    const token = current.token;
    yield* Effect.sync(input.onAwaiting);
    for (let check = 0; check < maximumApprovalChecks; check++) {
      if (current.status === "APPROVED") return token;
      if (current.status !== "PENDING") return yield* failure();
      yield* Effect.sleep("3 seconds");
      current = yield* requestToken({
        url: `${origin}/v1/tokens/nequi/${encodeURIComponent(Redacted.value(token))}`,
        publicKey: input.publicKey,
        fetch: input.fetch,
        body: Option.none(),
      });
      if (Redacted.value(current.token) !== Redacted.value(token)) return yield* failure();
    }
    return yield* failure();
  }).pipe(Effect.timeout("5 minutes"), Effect.mapError(failure));
