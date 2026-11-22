import { Effect, Option, Schema } from "effect";
import { OAuthRedirect, oauthResource } from "../../../src/shell/oauth-agents/contract";
import { OAuthClientId } from "../../../src/core/oauth-agents/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { BootstrapInvalid } from "./bootstrap";

const CodeExchange = Schema.Struct({
  grant_type: Schema.Literal("authorization_code"),
  code: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  client_id: OAuthClientId,
  redirect_uri: OAuthRedirect,
  resource: Schema.Literal(oauthResource),
  code_verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/u)),
});

type CodeExchange = typeof CodeExchange.Type;

const maximumScopeLength = 64;

const RefreshExchange = Schema.Struct({
  grant_type: Schema.Literal("refresh_token"),
  refresh_token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  client_id: OAuthClientId,
  resource: Schema.Literal(oauthResource),
  scope: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(maximumScopeLength))
  ),
});

const TokenExchange = Schema.Union([CodeExchange, RefreshExchange]);

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 3000,
});

export const decodeExchange = (
  request: Request
): Effect.Effect<typeof TokenExchange.Type, BootstrapInvalid> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedRequestBody(request, bodyPolicy);
    const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const fields = new URLSearchParams(text);

    if (new Set(fields.keys()).size !== Array.from(fields.keys()).length) {
      return yield* new BootstrapInvalid({ cause: Option.none() });
    }

    return yield* Schema.decodeUnknownEffect(TokenExchange, { onExcessProperty: "error" })(
      Object.fromEntries(fields)
    );
  }).pipe(Effect.mapError((cause) => new BootstrapInvalid({ cause: Option.some(cause) })));
