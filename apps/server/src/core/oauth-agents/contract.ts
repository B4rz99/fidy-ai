import { Schema } from "effect";
import type { PATLifetimeDays } from "~/core/tokens/contract";

export const oauthReviewLifetimeMs = 600_000;

export const oauthAuthorizationCodeLifetimeMs = 60_000;

export const oauthAccessLifetimeMs = 600_000;

export const oauthRefreshLifetimeMs = 2_592_000_000;

export type OAuthExpirationReview = Readonly<{
  current: number;
  reviewedAt: number;
  expiresAt: number;
  lifetimeDays: PATLifetimeDays;
}>;

export type OAuthCredentialExpirations = Readonly<{
  accessExpiresAt: number;
  refreshExpiresAt: number;
}>;

export const OAuthClientId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthClientId")
);

export type OAuthClientId = typeof OAuthClientId.Type;

export const OAuthConnectionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthConnectionId")
);

export type OAuthConnectionId = typeof OAuthConnectionId.Type;

export const OAuthCredentialId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthCredentialId")
);

export type OAuthCredentialId = typeof OAuthCredentialId.Type;
