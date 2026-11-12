import { Clock, Data, Effect, Function, Option, Redacted, Result, Schema } from "effect";
import { UnknownJsonString, jsonStringSchema } from "@/schema-compatibility";
import {
  type WompiFetch,
  readBoundedWompiResponse,
  wompiTokenizationOrigin,
} from "./wompi-tokenization";

export class NequiAuthorizationFailed extends Data.TaggedError("NequiAuthorizationFailed")<{
  readonly reason: "declined" | "unavailable" | "expired";
}> {}
const ignoreCancellation = (): void => {};
const maximumTokenCharacters = 4096;
const maximumApprovalChecks = 100;
const authorizationLifetimeMillis = 300_000;
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
const failure = (): NequiAuthorizationFailed =>
  new NequiAuthorizationFailed({ reason: "unavailable" });

const requestToken = (
  input: Readonly<{
    url: string;
    publicKey: string;
    fetchImplementation: WompiFetch;
    body: Option.Option<string>;
  }>
): Effect.Effect<
  Readonly<{ token: string; status: typeof TokenResponse.Type.data.status }>,
  NequiAuthorizationFailed
> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        input.fetchImplementation(input.url, {
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
      yield* Effect.sync(() => {
        response.body?.cancel().catch(ignoreCancellation);
      });
      return yield* failure();
    }
    const text = yield* readBoundedWompiResponse(response).pipe(Effect.mapError(failure));
    const json = decodeJson(text);
    if (Result.isFailure(json)) return yield* failure();
    const decoded = decodeToken(json.success);
    if (Result.isFailure(decoded)) return yield* failure();
    return { token: decoded.success.data.id, status: decoded.success.data.status };
  }).pipe(Effect.timeout("15 seconds"), Effect.mapError(failure));

type NequiAuthorizationInput = Readonly<{
  publicKey: string;
  phoneNumber: Redacted.Redacted<string>;
  fetchImplementation: WompiFetch;
  clearPhone: () => void;
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
      fetchImplementation: input.fetchImplementation,
      body: Option.some(
        yield* Schema.encodeEffect(NequiRequest)({ phone_number: phone }).pipe(
          Effect.mapError(failure)
        )
      ),
    });
  });

const notify = (callback: () => void): Effect.Effect<void> =>
  Effect.try({ try: callback, catch: () => undefined }).pipe(Effect.ignore);

type TokenObservation = Effect.Success<ReturnType<typeof requestToken>>;
const approvalObserved = (
  observation: TokenObservation,
  token: Redacted.Redacted<string>,
  deadline: number
): Effect.Effect<boolean, NequiAuthorizationFailed> =>
  Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* new NequiAuthorizationFailed({ reason: "expired" });
    }
    if (observation.token !== Redacted.value(token)) return yield* failure();
    if (observation.status === "APPROVED") return true;
    if (observation.status === "DECLINED") {
      return yield* new NequiAuthorizationFailed({ reason: "declined" });
    }
    if (observation.status !== "PENDING") return yield* failure();
    return false;
  });

const waitForApproval = (
  input: NequiAuthorizationInput,
  initial: TokenObservation,
  authorization: Readonly<{ origin: string; token: Redacted.Redacted<string>; deadline: number }>
): Effect.Effect<Redacted.Redacted<string>, NequiAuthorizationFailed> =>
  Effect.gen(function* () {
    const { origin, token, deadline } = authorization;
    let current = initial;
    let checks = 0;
    while (!(yield* approvalObserved(current, token, deadline))) {
      if (checks >= maximumApprovalChecks) return yield* failure();
      if (checks === 0) yield* notify(input.onAwaiting);
      yield* Effect.sleep("3 seconds");
      checks++;
      current = yield* requestToken({
        url: `${origin}/v1/tokens/nequi/${encodeURIComponent(Redacted.value(token))}`,
        publicKey: input.publicKey,
        fetchImplementation: input.fetchImplementation,
        body: Option.none(),
      });
    }
    return token;
  });

/**
 * Borrows one approved authorization into the consumer, then wipes the token on every exit.
 * Phone drafts are cleared even on preflight failure; progress callbacks cannot reject work.
 * Only authorization has the original five-minute deadline. Consumer failures and interruption
 * retain their own meaning and approval does not establish collection settlement.
 */
export const withApprovedNequiWithWompi: {
  <A, E, R>(
    consume: (token: Redacted.Redacted<string>) => Effect.Effect<A, E, R>
  ): (input: NequiAuthorizationInput) => Effect.Effect<A, NequiAuthorizationFailed | E, R>;
  <A, E, R>(
    input: NequiAuthorizationInput,
    consume: (token: Redacted.Redacted<string>) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, NequiAuthorizationFailed | E, R>;
} = Function.dual(
  2,
  <A, E, R>(
    input: NequiAuthorizationInput,
    consume: (token: Redacted.Redacted<string>) => Effect.Effect<A, E, R>
  ): Effect.Effect<A, NequiAuthorizationFailed | E, R> =>
    Effect.suspend(() => {
      let ownedToken: Option.Option<Redacted.Redacted<string>> = Option.none();
      let phoneCleared = false;
      const clearPhone = Effect.suspend(() => {
        if (phoneCleared) return Effect.void;
        phoneCleared = true;
        Redacted.wipeUnsafe(input.phoneNumber);
        return notify(input.clearPhone);
      });
      const authorize = Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + authorizationLifetimeMillis;
        const origin = yield* wompiTokenizationOrigin(input.publicKey).pipe(
          Effect.mapError(failure)
        );
        const initial = yield* initiateAuthorization(input, origin).pipe(
          Effect.ensuring(clearPhone)
        );
        const prefix = input.publicKey.startsWith("pub_test_") ? "nequi_test_" : "nequi_prod_";
        if (!initial.token.startsWith(prefix)) return yield* failure();
        const token = Redacted.make(initial.token);
        ownedToken = Option.some(token);
        return yield* waitForApproval(input, initial, { origin, token, deadline });
      }).pipe(
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () => Effect.fail(new NequiAuthorizationFailed({ reason: "expired" })),
        })
      );
      const wipeToken = Effect.sync(() => {
        if (Option.isSome(ownedToken)) Redacted.wipeUnsafe(ownedToken.value);
        ownedToken = Option.none();
      });
      return authorize.pipe(
        Effect.flatMap(consume),
        Effect.ensuring(clearPhone),
        Effect.ensuring(wipeToken)
      );
    })
);
