import { Effect, Option, Schema } from "effect";
import { OnboardingConsentBasis } from "../../../src/shell/consent/contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { TranscriptTurnId } from "../../../src/core/agent/contract";
import { AgentUnavailable } from "../contract";

const AdmittedRow = Schema.Struct({ consent_basis_json: Schema.String });

/** Read only the exact still-Pending User Turn's captured basis; it does not decide current Consent. */
export const readAdmittedBasis = ({
  db,
  userId,
  turnId,
}: Readonly<{ db: D1Database; userId: UserId; turnId: TranscriptTurnId }>): Effect.Effect<
  Option.Option<OnboardingConsentBasis>,
  AgentUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT s.consent_basis_json FROM hosted_turns t
        JOIN hosted_agent_sessions s ON s.id = t.hosted_session_id AND s.user_id = t.user_id
        WHERE t.id = ? AND t.user_id = ? AND t.status = 'pending'`)
          .bind(turnId, userId)
          .first(),
      catch: () => new AgentUnavailable(),
    });
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(AdmittedRow)(raw);
    const basis = yield* Schema.decodeEffect(Schema.fromJsonString(OnboardingConsentBasis))(
      row.consent_basis_json
    );
    return Option.some(basis);
  }).pipe(Effect.mapError(() => new AgentUnavailable()));
