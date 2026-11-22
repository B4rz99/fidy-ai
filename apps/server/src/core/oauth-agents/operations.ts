import type { PATScopes } from "~/core/tokens/contract";
import { patScopeCopy } from "~/core/tokens/operations";
import {
  type OAuthCredentialExpirations,
  type OAuthExpirationReview,
  oauthAccessLifetimeMs,
  oauthAuthorizationCodeLifetimeMs,
  oauthRefreshLifetimeMs,
  oauthReviewLifetimeMs,
} from "./contract";

const dayMs = 86_400_000;

export const isReviewedOAuthExpiration = (input: OAuthExpirationReview): boolean =>
  input.reviewedAt <= input.current &&
  input.reviewedAt + oauthReviewLifetimeMs > input.current &&
  input.expiresAt === input.reviewedAt + input.lifetimeDays * dayMs;

export const oauthAuthorizationCodeExpiresAt = (current: number): number =>
  current + oauthAuthorizationCodeLifetimeMs;

export const decideOAuthCredentialExpirations = (
  input: Readonly<{ current: number; grantExpiresAt: number }>
): OAuthCredentialExpirations => ({
  accessExpiresAt: Math.min(input.current + oauthAccessLifetimeMs, input.grantExpiresAt),
  refreshExpiresAt: Math.min(input.current + oauthRefreshLifetimeMs, input.grantExpiresAt),
});

export const oauthScopeCopy: Readonly<
  Record<PATScopes[number], Readonly<{ label: string; description: string }>>
> = {
  read: { label: "Consultar tus datos", description: patScopeCopy.read.description },
  write: { label: "Crear y modificar tus datos", description: patScopeCopy.write.description },
  dashboard: { label: "Ver y editar tu tablero", description: patScopeCopy.dashboard.description },
};
