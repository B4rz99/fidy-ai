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

/** Reject future, stale or altered reviews without recalculating their absolute grant expiration. */
export const isReviewedOAuthExpiration = (input: OAuthExpirationReview): boolean =>
  input.reviewedAt <= input.current &&
  input.reviewedAt + oauthReviewLifetimeMs > input.current &&
  input.expiresAt === input.reviewedAt + input.lifetimeDays * dayMs;
/** A code is short-lived independently of the later finite credential lifetimes. */
export const oauthAuthorizationCodeExpiresAt = (current: number): number =>
  current + oauthAuthorizationCodeLifetimeMs;
/** Finite credentials share the reviewed grant's absolute upper bound, never a sliding grant. */
export const decideOAuthCredentialExpirations = (
  input: Readonly<{ current: number; grantExpiresAt: number }>
): OAuthCredentialExpirations => ({
  accessExpiresAt: Math.min(input.current + oauthAccessLifetimeMs, input.grantExpiresAt),
  refreshExpiresAt: Math.min(input.current + oauthRefreshLifetimeMs, input.grantExpiresAt),
});

/** Approved OAuth disclosure labels share the existing capability facts without changing PAT UX. */
export const oauthScopeCopy: Readonly<
  Record<PATScopes[number], Readonly<{ label: string; description: string }>>
> = {
  read: { label: "Consultar tus datos", description: patScopeCopy.read.description },
  write: { label: "Crear y modificar tus datos", description: patScopeCopy.write.description },
  dashboard: { label: "Ver y editar tu tablero", description: patScopeCopy.dashboard.description },
};
