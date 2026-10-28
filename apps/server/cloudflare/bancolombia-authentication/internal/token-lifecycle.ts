import { Clock, Effect, Option, type Redacted, Result, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { makeBancolombiaSandboxOutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  BancolombiaAuthenticationFailed,
  type BancolombiaBankGrant,
  type BancolombiaCleanupProof,
} from "../contract";

const successfulStatus = 200;
const Introspection = Schema.Struct({
  active: Schema.Boolean,
  client_id: Schema.optionalKey(Schema.String),
});
const failed = (): BancolombiaAuthenticationFailed =>
  new BancolombiaAuthenticationFailed({ stage: "bancolombia_token_lifecycle" });
type Client = Readonly<{
  clientId: string;
  assertion: Effect.Effect<Redacted.Redacted<string>, BancolombiaAuthenticationFailed>;
  httpClient: HttpClient.HttpClient;
}>;
type Token = Readonly<{
  token: Redacted.Redacted<string>;
  tokenType: "access_token" | "refresh_token";
}>;
const inspectToken = (
  input: Client,
  token: Token
): Effect.Effect<boolean, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const response = yield* makeBancolombiaSandboxOutboundHttp(input.httpClient).execute({
      _tag: "InspectBankToken",
      ...token,
      assertion: yield* input.assertion,
    });
    if (response.status !== successfulStatus) return yield* failed();
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Introspection))(
      new TextDecoder().decode(response.body)
    );
    if (decoded.client_id !== undefined && decoded.client_id !== input.clientId) {
      return yield* failed();
    }
    return decoded.active;
  }).pipe(Effect.mapError(failed));
const revokeToken = (
  input: Client,
  token: Token
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const response = yield* makeBancolombiaSandboxOutboundHttp(input.httpClient).execute({
      _tag: "RevokeBankToken",
      ...token,
      assertion: yield* input.assertion,
    });
    if (response.status !== successfulStatus) return yield* failed();
  }).pipe(Effect.mapError(failed));

export const verifyTokenLifecycle = (
  input: Client &
    Readonly<{
      bearer: Redacted.Redacted<string>;
      expiresAtMilliseconds: number;
    }>
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const token: Token = { token: input.bearer, tokenType: "access_token" };
    const before = yield* inspectToken(input, token).pipe(Effect.result);
    yield* revokeToken(input, token);
    if (Result.isFailure(before) || !before.success) return yield* failed();
    if (
      (yield* inspectToken(input, token)) ||
      (yield* Clock.currentTimeMillis) >= input.expiresAtMilliseconds
    ) {
      return yield* failed();
    }
  });
type Cleanup = Client & Readonly<{ grant: BancolombiaBankGrant; proof: BancolombiaCleanupProof }>;
const prepareCleanupToken = (
  input: Cleanup,
  token: Token
): Effect.Effect<Token, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const active = yield* inspectToken(input, token);
    if (active) {
      yield* input.proof.recordActive(token.tokenType);
    } else if (
      !input.proof.observedTokens.includes(token.tokenType) &&
      !(
        token.tokenType === "access_token" &&
        (yield* Clock.currentTimeMillis) >= input.grant.expiresAtMilliseconds
      )
    ) {
      return yield* failed();
    }
    return token;
  }).pipe(Effect.mapError(failed));
const cleanupToken = (
  input: Client,
  token: Token
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    yield* revokeToken(input, token);
    if (yield* inspectToken(input, token)) return yield* failed();
  });
export const revokeGrant = (input: Cleanup): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const tokens: ReadonlyArray<Token> = [
      ...Option.toArray(
        Option.map(input.grant.refreshToken, (token): Token => ({
          token,
          tokenType: "refresh_token",
        }))
      ),
      { token: input.grant.accessToken, tokenType: "access_token" },
    ];
    const prepared = yield* Effect.forEach(tokens, (token) =>
      prepareCleanupToken(input, token).pipe(Effect.result)
    );
    let incomplete = false;
    for (const token of prepared) {
      if (Result.isFailure(token)) {
        incomplete = true;
        continue;
      }
      const cleaned = yield* cleanupToken(input, token.success).pipe(Effect.result);
      if (Result.isFailure(cleaned)) incomplete = true;
    }
    if (incomplete) return yield* failed();
  }).pipe(Effect.timeout("60 seconds"), Effect.mapError(failed));
