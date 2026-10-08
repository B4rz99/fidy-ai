import { ProviderAuthenticationRetentionUnavailable } from "./contract";
import { Effect } from "effect";

const maximumSweepRows = 500;
const retainedAttemptMilliseconds = 86_400_000;
/** Removes expired provider protocol state after one day; durable credentials and Consent remain owned by their records. */
export const sweepProviderAuthentication = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): Effect.Effect<
  void,
  ProviderAuthenticationRetentionUnavailable
> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "DELETE FROM completed_provider_authentications WHERE attempt_id IN (SELECT id FROM provider_authentication_attempts WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
      db
        .prepare(
          "DELETE FROM provider_authentication_attempts WHERE id IN (SELECT id FROM provider_authentication_attempts WHERE expires_at_ms<? ORDER BY expires_at_ms,id LIMIT ?)"
        )
        .bind(current - retainedAttemptMilliseconds, maximumSweepRows),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ProviderAuthenticationRetentionUnavailable())
  );
