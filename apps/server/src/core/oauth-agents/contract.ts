import { Schema } from "effect";
import type { PATLifetimeDays } from "~/core/tokens/contract";

/** Approval must finish within ten minutes of the exact displayed review, never renewing its anchor. */
export const oauthReviewLifetimeMs = 600_000;
/** A single-use PKCE authorization code expires one minute after publication. */
export const oauthAuthorizationCodeLifetimeMs = 60_000;
/** Access authority lasts at most ten minutes and remains capped by the absolute grant expiration. */
export const oauthAccessLifetimeMs = 600_000;
/** Refresh authority lasts at most thirty days and never extends the absolute reviewed grant. */
export const oauthRefreshLifetimeMs = 2_592_000_000;
/** Exact reviewed absolute expiration; timestamps are epoch milliseconds. */
export type OAuthExpirationReview = Readonly<{
  current: number;
  reviewedAt: number;
  expiresAt: number;
  lifetimeDays: PATLifetimeDays;
}>;
/** Issuance never extends either credential beyond the immutable grant. */
export type OAuthCredentialExpirations = Readonly<{
  accessExpiresAt: number;
  refreshExpiresAt: number;
}>;
/** Stable identity of one registered external OAuth client, never a grant or credential. */
export const OAuthClientId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthClientId")
);
export type OAuthClientId = typeof OAuthClientId.Type;

/** Stable identity of one separately reviewed external-agent authorization. */
export const OAuthConnectionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthConnectionId")
);
export type OAuthConnectionId = typeof OAuthConnectionId.Type;
/** Safe credential identity for accountability, never bearer material. */
export const OAuthCredentialId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("OAuthCredentialId")
);
export type OAuthCredentialId = typeof OAuthCredentialId.Type;
