import { Clock, Effect, type Redacted, Result, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { makeBancolombiaSandboxOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { BancolombiaAuthenticationFailed } from "../contract";

const successfulStatus = 200;
const Introspection = Schema.Struct({
  active: Schema.Boolean,
  client_id: Schema.optionalKey(Schema.String),
});
const failed = (): BancolombiaAuthenticationFailed =>
  new BancolombiaAuthenticationFailed({ stage: "bancolombia_token_lifecycle" });

export const verifyTokenLifecycle = (
  input: Readonly<{
    clientId: string;
    bearer: Redacted.Redacted<string>;
    expiresAtMilliseconds: number;
    assertion: Effect.Effect<Redacted.Redacted<string>, BancolombiaAuthenticationFailed>;
    httpClient: HttpClient.HttpClient;
  }>
): Effect.Effect<void, BancolombiaAuthenticationFailed> =>
  Effect.gen(function* () {
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const inspect = Effect.gen(function* () {
      const response = yield* http.execute({
        _tag: "InspectBankToken",
        assertion: yield* input.assertion,
        token: input.bearer,
        tokenType: "access_token",
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
    const before = yield* inspect.pipe(Effect.result);
    const revoked = yield* http.execute({
      _tag: "RevokeBankToken",
      assertion: yield* input.assertion,
      token: input.bearer,
      tokenType: "access_token",
    });
    if (revoked.status !== successfulStatus || Result.isFailure(before) || !before.success) {
      return yield* failed();
    }
    const stillActive = yield* inspect;
    if (stillActive || (yield* Clock.currentTimeMillis) >= input.expiresAtMilliseconds) {
      return yield* failed();
    }
  }).pipe(Effect.mapError(failed));
