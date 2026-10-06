import { Effect } from "effect";
import { OAuthConfirmationRetentionUnavailable } from "./contract";

const maximumSweepRows = 500;
/** Delete bounded expired private work. Cancellation/expiry never claims rollback of committed work. */
export const sweepOAuthConfirmation = (
  input: Readonly<{ db: D1Database; current: number }>
): Effect.Effect<void, OAuthConfirmationRetentionUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(`DELETE FROM oauth_operation_intents WHERE reference IN
    (SELECT reference FROM oauth_operation_intents WHERE expires_at_ms <= ? ORDER BY expires_at_ms, reference LIMIT ?)`)
      .bind(input.current, maximumSweepRows)
      .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new OAuthConfirmationRetentionUnavailable())
  );
