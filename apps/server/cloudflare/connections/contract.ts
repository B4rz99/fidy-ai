import type { SecureRandom } from "effect/crypto";
import { Context, Data, type Effect, Option, type Redacted, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import { ConnectionAttemptReference } from "../../src/shell/connections/contract";

const digestLength = 32;

const maximumByte = 255;

export const ConnectionBrowserAdmission = Schema.Struct({
  attempt: ConnectionAttemptReference,
  userId: UserId,
  sessionId: WebSessionId,
  digest: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumByte }))
  ).check(Schema.isBetweenLength(digestLength, digestLength)),
  deadlineMilliseconds: Schema.Int,
});

export type ConnectionBrowserAdmission = typeof ConnectionBrowserAdmission.Type;

export const ConnectionSandboxAdmission = Context.Reference<
  Option.Option<Readonly<{ userId: string; startsAt: number; expiresAt: number }>>
>("@fidy/cloudflare/connections/SandboxAdmission", { defaultValue: Option.none });

export class ConnectionAuthorizationUnavailable extends Data.TaggedError(
  "ConnectionAuthorizationUnavailable"
)<{ readonly cause: unknown }> {}

const maximumPermissionCount = 5;

export const ConnectionConsentIntent = Schema.Struct({
  permissions: Schema.Array(
    Schema.Literals([
      "ReadAccountsBasic",
      "ReadBalances",
      "ReadTransactionsDetail",
      "ReadTransactionsCredits",
      "ReadTransactionsDebits",
    ])
  ).check(
    Schema.isBetweenLength(1, maximumPermissionCount),
    Schema.makeFilter((values) => new Set(values).size === values.length)
  ),
  historyPolicy: Schema.Literal("bank-default"),
  expiryPolicy: Schema.Literal("bank-default"),
});

export type ConnectionConsentIntent = typeof ConnectionConsentIntent.Type;

export type ConnectionBankPreparation = Readonly<{
  intent: ConnectionConsentIntent;
  prepare: (
    input: Readonly<{
      userId: UserId;
      attempt: typeof ConnectionAttemptReference.Type;
      state: string;
      challenge: string;
      recordConsent: (consentId: string) => Effect.Effect<void, ConnectionAuthorizationUnavailable>;
      expiresAtMilliseconds: number;
    }>
  ) => Effect.Effect<
    Readonly<{ url: string; expiresAtMilliseconds: number }>,
    ConnectionAuthorizationUnavailable
  >;
}>;

export const connectionCallbackPath = "/connections/bancolombia/sandbox/callback";

const maximumCodeLength = 4096;

export const ConnectionCallbackAdmission = Schema.Struct({
  ...ConnectionBrowserAdmission.fields,
  state: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  result: Schema.Union([
    Schema.TaggedStruct("Code", {
      code: Schema.String.check(
        Schema.isBetweenLength(1, maximumCodeLength),
        Schema.isPattern(/^[\x21-\x7e]+$/u)
      ),
    }),
    Schema.TaggedStruct("Denied", {}),
  ]),
});

export type ConnectionCallbackAdmission = typeof ConnectionCallbackAdmission.Type;

export type ConnectionBankGrant = Readonly<{
  accessToken: Option.Option<Redacted.Redacted<string>>;
  refreshToken: Option.Option<Redacted.Redacted<string>>;
  expiresAtMilliseconds: number;
}>;

export type ConnectionBankActivation = Readonly<{
  clientId: string;
  activate: (
    input: Readonly<{
      userId: UserId;
      code: Redacted.Redacted<string>;
      verifier: Redacted.Redacted<string>;
      consentId: string;
      state: string;
      intent: ConnectionConsentIntent;
      expiresAtMilliseconds: number;
      retainGrant: (
        grant: ConnectionBankGrant
      ) => Effect.Effect<void, ConnectionAuthorizationUnavailable, SecureRandom.SecureRandom>;
    }>
  ) => Effect.Effect<
    ReadonlyArray<string>,
    ConnectionAuthorizationUnavailable,
    SecureRandom.SecureRandom
  >;
}>;

export type ConnectionBankCleanup = Readonly<{
  clientId: string;
  revoke: (
    input: Readonly<{
      grant: ConnectionBankGrant;
      observedTokens: ReadonlyArray<"access_token" | "refresh_token">;
      recordActive: (
        tokenType: "access_token" | "refresh_token"
      ) => Effect.Effect<void, ConnectionAuthorizationUnavailable>;
    }>
  ) => Effect.Effect<void, ConnectionAuthorizationUnavailable>;
}>;

export const SynchronizationWork = Schema.Struct({
  kind: Schema.Literal("connection-synchronization"),
  userId: UserId,
  jobId: Schema.String.check(Schema.isUUID()),
});

export type SynchronizationWork = typeof SynchronizationWork.Type;

export type SynchronizationProvider = {
  clientId: string;
  refreshIntervalMs: number;
  page: (input: {
    accountReference: string;
    cursor: Option.Option<string>;
    work: SynchronizationWork;
    grant: ConnectionBankGrant;
  }) => Effect.Effect<unknown, ConnectionAuthorizationUnavailable>;
};

export type ConnectionAdapters = {
  preparation: Option.Option<ConnectionBankPreparation>;
  activation: Option.Option<ConnectionBankActivation>;
  cleanup: Option.Option<ConnectionBankCleanup>;
  synchronization: Option.Option<SynchronizationProvider>;
  grantKey: Option.Option<Redacted.Redacted<string>>;
};
