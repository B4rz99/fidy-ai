import { type Effect } from "effect";
import { recoverDisclosures, sweepExpired } from "./internal/ingress";

/** Resume only disclosures that never claimed their irreversible provider-send boundary. */
export const recoverPendingDisclosures = (
  input: Readonly<{ db: D1Database; apiKey: string }>
): Effect.Effect<void, void> => recoverDisclosures(input);

/** Expire bounded pre-User decisions and their temporary delivery metadata. */
export const sweepExpiredConsent = (db: D1Database): (() => Effect.Effect<void, void>) =>
  sweepExpired(db);
