import type { Effect } from "effect";
import type { ConsentIngressEnvironment } from "./contract";
import { receiveIngress, recoverDisclosures, sweepExpired } from "./internal/ingress";

/** Construct one authenticated, bounded ingress with native provider transport and telemetry. */
export const receiveConsentWebhook = (
  environment: ConsentIngressEnvironment
): ((request: Request) => Effect.Effect<Response>) => receiveIngress(environment);

/** Resume only disclosures that never claimed their irreversible provider-send boundary. */
export const recoverPendingDisclosures = (
  input: Readonly<{ db: D1Database; apiKey: string }>
): Effect.Effect<void, void> => recoverDisclosures(input);

/** Expire bounded pre-User decisions and their temporary delivery metadata. */
export const sweepExpiredConsent = (db: D1Database): (() => Effect.Effect<void, void>) =>
  sweepExpired(db);
