import { Effect, Schema } from "effect";
import { DisclosureSnapshot, OnboardingConsentBasis } from "../../../src/shell/consent/contract";
import { type ConsentStanding, type ConsentStatus, ConsentUnavailable } from "../contract";

const StandingRow = Schema.Struct({
  id: Schema.String,
  disclosure_json: Schema.String,
  revoked: Schema.Literals([0, 1]),
});
const StatusRow = Schema.Struct({
  granted: Schema.Literals([0, 1]),
  revoked: Schema.Literals([0, 1]),
});

export const loadStatus = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  ConsentStatus,
  ConsentUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(`SELECT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = ?) AS granted,
      EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = ?) AS revoked`)
        .bind(userId, userId)
        .first(),
    catch: () => new ConsentUnavailable(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StatusRow)),
    Effect.map((row): ConsentStatus => {
      if (row.revoked === 1) return "Revoked";
      return row.granted === 1 ? "Granted" : "Missing";
    }),
    Effect.mapError(() => new ConsentUnavailable())
  );

export const loadStanding = ({
  db,
  userId,
}: Readonly<{ db: D1Database; userId: string }>): Effect.Effect<
  ConsentStanding,
  ConsentUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT id, disclosure_json,
        EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = c.user_id) AS revoked
        FROM onboarding_consent_records c WHERE user_id = ?`)
          .bind(userId)
          .first(),
      catch: () => new ConsentUnavailable(),
    });
    if (raw === null) return { _tag: "Missing", subjectUserId: userId } as const;
    const row = yield* Schema.decodeUnknownEffect(StandingRow)(raw);
    const disclosure = yield* Schema.decodeEffect(Schema.fromJsonString(DisclosureSnapshot))(
      row.disclosure_json
    );
    const basis = yield* Schema.decodeEffect(OnboardingConsentBasis)({
      grantId: row.id,
      disclosureRevision: disclosure.revision,
      disclosureSha256: disclosure.contentSha256,
      policyRevision: disclosure.policy.revision,
      policySha256: disclosure.policy.contentSha256,
    });
    return {
      _tag: row.revoked === 1 ? ("Revoked" as const) : ("Granted" as const),
      subjectUserId: userId,
      basis,
    };
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));
