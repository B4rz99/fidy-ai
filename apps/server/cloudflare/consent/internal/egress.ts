import { Effect, Option, Schema } from "effect";
import { OnboardingConsentBasis } from "@fidy/server/consent-contract";
import type { TranscriptTurnId } from "@fidy/server/agent-runtime";
import { type ConsentEgressAction, ConsentEgressRefused, ConsentUnavailable } from "../contract";
import { loadStanding } from "./standing";

const AdmittedRow = Schema.Struct({ consent_basis_json: Schema.String });

const checkEgress = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    admittedTurnId: Option.Option<TranscriptTurnId>;
  }>
): Effect.Effect<"allowed" | "denied", ConsentUnavailable> =>
  Effect.gen(function* () {
    const standing = yield* loadStanding(input);
    if (standing._tag === "Missing") return "denied" as const;
    if (Option.isNone(input.admittedTurnId)) {
      return standing._tag === "Granted" ? ("allowed" as const) : ("denied" as const);
    }
    const turnId = input.admittedTurnId.value;
    const raw = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT s.consent_basis_json FROM hosted_turns t
        JOIN hosted_agent_sessions s ON s.id = t.hosted_session_id AND s.user_id = t.user_id
        WHERE t.id = ? AND t.user_id = ? AND t.status = 'pending'`)
          .bind(turnId, input.userId)
          .first(),
      catch: () => new ConsentUnavailable(),
    });
    if (raw === null) return "denied" as const;
    const row = yield* Schema.decodeUnknownEffect(AdmittedRow)(raw);
    const basis = yield* Schema.decodeEffect(Schema.fromJsonString(OnboardingConsentBasis))(
      row.consent_basis_json
    );
    return matchesBasis(basis, standing.basis) ? ("allowed" as const) : ("denied" as const);
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const matchesBasis = (left: OnboardingConsentBasis, right: OnboardingConsentBasis): boolean =>
  left.grantId === right.grantId &&
  left.disclosureRevision === right.disclosureRevision &&
  left.disclosureSha256 === right.disclosureSha256 &&
  left.policyRevision === right.policyRevision &&
  left.policySha256 === right.policySha256;

export const performEgress = <A, E, R>(
  input: ConsentEgressAction<A, E, R>
): Effect.Effect<A, E | ConsentEgressRefused | ConsentUnavailable, R> =>
  checkEgress(input).pipe(
    Effect.flatMap((decision): Effect.Effect<A, E | ConsentEgressRefused, R> =>
      decision === "allowed" ? input.action : Effect.fail(new ConsentEgressRefused())
    )
  );
