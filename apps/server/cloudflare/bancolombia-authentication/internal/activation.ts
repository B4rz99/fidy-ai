import { Clock, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { createLocalJWKSet, jwtVerify } from "jose";
import { makeBancolombiaSandboxOutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  type BancolombiaActivationInput,
  type BancolombiaAuthenticationFailed,
  BancolombiaAuthorizationFailed,
  type SandboxAuthenticationInput,
} from "../contract";
import { ConnectionConsentIntent } from "../../connections/contract";

type Client = SandboxAuthenticationInput;
type Input = Client & BancolombiaActivationInput;
const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const signingKeys =
  "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server";
const tokenEndpoint = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const accountsEndpoint =
  "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts";
const maximumTokenLength = 32768;
const maximumTokenSeconds = 86400;
const maximumKeyIdLength = 128;
const minimumModulusLength = 342;
const maximumModulusLength = 1400;
const maximumExponentLength = 16;
const maximumSigningKeys = 32;
const maximumAccountReferenceLength = 512;
const maximumAccounts = 1000;
const maximumPages = 20;
const maximumPageLinkLength = 500;
const successfulResponse = 200;
const millisecondsPerSecond = 1000;
const maximumIdentityAge = 600;
const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isBetweenLength(1, maximumTokenLength)),
  refresh_token: Schema.optionalKey(
    Schema.String.check(Schema.isBetweenLength(1, maximumTokenLength))
  ),
  id_token: Schema.String.check(Schema.isBetweenLength(1, maximumTokenLength)),
  token_type: Schema.String.check(Schema.isPattern(/^Bearer$/iu)),
  expires_in: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumTokenSeconds })),
  scope: Schema.optionalKey(
    Schema.String.check(
      Schema.makeFilter((value) => {
        const scopes = value.split(" ");
        return (
          scopes.includes("accounts") &&
          scopes.every((scope) => scope === "accounts" || scope === "openid")
        );
      })
    )
  ),
});
const HeldGrant = Schema.Struct({
  access_token: TokenResponse.fields.access_token,
  refresh_token: Schema.optionalKey(Schema.Unknown),
  expires_in: Schema.optionalKey(Schema.Unknown),
});
const BankKeys = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("RSA"),
      kid: Schema.String.check(Schema.isBetweenLength(1, maximumKeyIdLength)),
      n: Schema.String.check(Schema.isBetweenLength(minimumModulusLength, maximumModulusLength)),
      e: Schema.String.check(Schema.isBetweenLength(1, maximumExponentLength)),
      alg: Schema.optionalKey(Schema.Literals(["RS256", "PS256"])),
      use: Schema.optionalKey(Schema.Literal("sig")),
    })
  ).check(Schema.isBetweenLength(1, maximumSigningKeys)),
});
const Discovery = Schema.Struct({
  issuer: Schema.Literal(issuer),
  jwks_uri: Schema.Literal(signingKeys),
  token_endpoint: Schema.Literal(tokenEndpoint),
  tls_client_certificate_bound_access_tokens: Schema.Literal(true),
  mtls_endpoint_aliases: Schema.Struct({ token_endpoint: Schema.Literal(tokenEndpoint) }),
});
const Consent = Schema.Struct({
  Data: Schema.Struct({
    ConsentId: Schema.String,
    Status: Schema.Literals(["Authorised", "Authorized"]),
    Permissions: ConnectionConsentIntent.fields.permissions,
  }),
});
const PageLink = Schema.String.check(Schema.isBetweenLength(1, maximumPageLinkLength));
const PageLinks = Schema.Struct({
  Self: Schema.optionalKey(PageLink),
  Previous: Schema.optionalKey(PageLink),
  Next: Schema.optionalKey(PageLink),
  Last: Schema.optionalKey(PageLink),
});
const AccountPage = Schema.Struct({
  Data: Schema.Struct({
    AccountReport: Schema.Array(
      Schema.Struct({
        AccountIdentification: Schema.String.check(
          Schema.isBetweenLength(1, maximumAccountReferenceLength)
        ),
      })
    ).check(Schema.isBetweenLength(0, maximumAccounts)),
    Links: Schema.optionalKey(PageLinks),
  }),
});
const failed = (): BancolombiaAuthorizationFailed => new BancolombiaAuthorizationFailed();
const checkHash = (
  input: Input,
  claim: unknown,
  value: string
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    if (claim === undefined) return;
    const digest = yield* input.crypto.digest("SHA-256", new TextEncoder().encode(value));
    if (claim !== Base64Url.encode(digest.slice(0, digest.length / 2))) return yield* failed();
  }).pipe(Effect.mapError(failed));
const validateIdentity = (
  input: Input,
  response: typeof TokenResponse.Type,
  keys: typeof BankKeys.Type
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(response.id_token, createLocalJWKSet({ keys: [...keys.keys] }), {
          issuer,
          audience: input.clientId,
          algorithms: ["RS256", "PS256"],
          currentDate: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
          requiredClaims: ["iss", "sub", "aud", "iat", "exp"],
          maxTokenAge: maximumIdentityAge,
        }),
      catch: failed,
    });
    const claims = verified.payload;
    if (
      claims.sub === undefined ||
      claims.sub.length === 0 ||
      claims.aud !== input.clientId ||
      (claims.azp !== undefined && claims.azp !== input.clientId) ||
      (claims.openbanking_intent_id !== undefined &&
        claims.openbanking_intent_id !== input.consentId)
    ) {
      return yield* failed();
    }
    yield* checkHash(input, claims.at_hash, response.access_token);
    yield* checkHash(input, claims.c_hash, Redacted.value(input.code));
    yield* checkHash(input, claims.s_hash, input.state);
  });
const nextPage = (value: string): Option.Option<number> => {
  const parsed = Option.flatMap(Option.fromNullishOr(URL.parse(value)), (url) => {
    if (
      `${url.origin}${url.pathname}` !== accountsEndpoint ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.size !== 1
    ) {
      return Option.none();
    }
    const page = url.searchParams.get("pageNumber");
    return page !== null && /^[1-9][0-9]{0,4}$/u.test(page)
      ? Option.some(Number(page))
      : Option.none();
  });
  return parsed;
};
const appendAccounts = (
  accounts: Set<string>,
  page: typeof AccountPage.Type
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    for (const account of page.Data.AccountReport) {
      if (accounts.has(account.AccountIdentification) || accounts.size >= maximumAccounts) {
        return yield* failed();
      }
      accounts.add(account.AccountIdentification);
    }
  });
const validatePosition = (
  links: (typeof AccountPage.Type)["Data"]["Links"],
  pageCount: number
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    for (const { link, position } of [
      { link: links?.Self, position: pageCount },
      { link: links?.Previous, position: pageCount - 1 },
    ]) {
      if (link === undefined) continue;
      const parsed = nextPage(link);
      if (Option.isNone(parsed) || parsed.value !== position) return yield* failed();
    }
  });
const validateCompletion = (
  totalPages: Option.Option<number>,
  accountCount: number,
  pageCount: number
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  accountCount === 0 || Option.getOrElse(totalPages, () => pageCount) !== pageCount
    ? Effect.fail(failed())
    : Effect.void;
const followingPage = (
  input: Readonly<{
    decoded: typeof AccountPage.Type;
    visited: Set<number>;
    totalPages: Option.Option<number>;
    accountCount: number;
    pageCount: number;
  }>
): Effect.Effect<Option.Option<number>, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const { decoded, visited, accountCount, pageCount } = input;
    const links = decoded.Data.Links;
    yield* validatePosition(links, pageCount);
    const next = links?.Next;
    if (next === undefined) {
      yield* validateCompletion(input.totalPages, accountCount, pageCount);
      return Option.none<number>();
    }
    const page = nextPage(next);
    if (Option.isNone(page) || visited.has(page.value) || page.value !== pageCount + 1) {
      return yield* failed();
    }
    if (Option.isSome(input.totalPages) && page.value > input.totalPages.value) {
      return yield* failed();
    }
    visited.add(page.value);
    return page;
  });
const reconcilePageTotal = (
  previous: Option.Option<number>,
  page: typeof AccountPage.Type
): Effect.Effect<Option.Option<number>, BancolombiaAuthorizationFailed> => {
  const last = page.Data.Links?.Last;
  if (last === undefined) return Effect.succeed(previous);
  const declared = nextPage(last);
  if (
    Option.isNone(declared) ||
    declared.value > maximumPages ||
    (Option.isSome(previous) && previous.value !== declared.value)
  ) {
    return Effect.fail(failed());
  }
  return Effect.succeed(declared);
};
const discoverAccounts = (
  input: Input,
  bearer: Redacted.Redacted<string>
): Effect.Effect<ReadonlyArray<string>, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const accounts = new Set<string>();
    const visited = new Set<number>();
    let page = Option.none<number>();
    let totalPages = Option.none<number>();
    for (let index = 0; index < maximumPages; index += 1) {
      if ((yield* Clock.currentTimeMillis) >= input.expiresAtMilliseconds) return yield* failed();
      const interactionId = yield* input.crypto.randomUUIDv4();
      const response = yield* http.execute({
        _tag: "ReadBankAccounts",
        bearer,
        interactionId,
        page,
      });
      if (response.status !== successfulResponse) return yield* failed();
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(AccountPage))(
        new TextDecoder().decode(response.body)
      );
      totalPages = yield* reconcilePageTotal(totalPages, decoded);
      yield* appendAccounts(accounts, decoded);
      page = yield* followingPage({
        decoded,
        totalPages,
        visited,
        accountCount: accounts.size,
        pageCount: index + 1,
      });
      if (Option.isNone(page)) return Array.from(accounts);
    }
    return yield* failed();
  }).pipe(Effect.mapError(failed));

export const activate = (
  input: Input &
    Readonly<{
      assertion: Effect.Effect<Redacted.Redacted<string>, BancolombiaAuthenticationFailed>;
      consentBearer: Effect.Effect<Redacted.Redacted<string>, BancolombiaAuthenticationFailed>;
    }>
): Effect.Effect<ReadonlyArray<string>, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    if (input.expiresAtMilliseconds <= (yield* Clock.currentTimeMillis)) return yield* failed();
    const signed = yield* input.assertion;
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const discovery = yield* http.execute({ _tag: "Discovery" });
    if (discovery.status !== successfulResponse) return yield* failed();
    yield* Schema.decodeEffect(Schema.fromJsonString(Discovery))(
      new TextDecoder().decode(discovery.body)
    );
    const keyResponse = yield* http.execute({ _tag: "BankSigningKeys" });
    if (keyResponse.status !== successfulResponse) return yield* failed();
    const keys = yield* Schema.decodeEffect(Schema.fromJsonString(BankKeys))(
      new TextDecoder().decode(keyResponse.body)
    );
    const exchangedAt = yield* Clock.currentTimeMillis;
    if (exchangedAt >= input.expiresAtMilliseconds) return yield* failed();
    const response = yield* http.execute({
      _tag: "ExchangeBankCode",
      assertion: signed,
      code: input.code,
      verifier: input.verifier,
    });
    if (response.status !== successfulResponse) return yield* failed();
    const body = new TextDecoder().decode(response.body);
    const held = yield* Schema.decodeEffect(Schema.fromJsonString(HeldGrant))(body);
    const seconds = Schema.decodeUnknownOption(TokenResponse.fields.expires_in)(held.expires_in);
    const accessToken = Redacted.make(held.access_token);
    yield* input.retainGrant({
      accessToken,
      refreshToken: Option.map(
        Schema.decodeUnknownOption(TokenResponse.fields.access_token)(held.refresh_token),
        Redacted.make
      ),
      expiresAtMilliseconds: Option.match(seconds, {
        onNone: () => Number.MAX_SAFE_INTEGER,
        onSome: (value) => exchangedAt + value * millisecondsPerSecond,
      }),
    });
    const accepted = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(body);
    yield* validateIdentity(input, accepted, keys);
    const consentBearer = yield* input.consentBearer;
    yield* verifyConsent(input, consentBearer);
    const accounts = yield* discoverAccounts(input, accessToken);
    yield* verifyConsent(input, consentBearer);
    return accounts;
  }).pipe(Effect.mapError(failed), Effect.timeout("60 seconds"), Effect.mapError(failed));

const verifyConsent = (
  input: Input,
  bearer: Redacted.Redacted<string>
): Effect.Effect<void, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const http = makeBancolombiaSandboxOutboundHttp(input.httpClient);
    const consent = yield* http.execute({
      _tag: "ReadBankConsent",
      bearer,
      consentId: input.consentId,
      interactionId: yield* input.crypto.randomUUIDv4(),
    });
    if (consent.status !== successfulResponse) return yield* failed();
    const verifiedConsent = yield* Schema.decodeEffect(Schema.fromJsonString(Consent))(
      new TextDecoder().decode(consent.body)
    );
    const permissions = verifiedConsent.Data.Permissions;
    if (
      verifiedConsent.Data.ConsentId !== input.consentId ||
      permissions.length !== input.intent.permissions.length ||
      !permissions.every((permission) => input.intent.permissions.includes(permission))
    ) {
      return yield* failed();
    }
  }).pipe(Effect.mapError(failed));
