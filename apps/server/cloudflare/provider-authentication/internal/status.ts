import { newId } from "../../secret-material/operations";
import { admitProviderPoll } from "./admission";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import {
  type AuthenticationProvider,
  ProviderBrowserProof,
} from "../../../src/shell/provider-authentication/contract";
import { provePendingBrowserPairing } from "../../browser-login/operations";
import { boundedJsonBody } from "../../http/operations";
import type { ProviderEnvironment } from "../contract";
import { providerBodyPolicy, providerJson } from "./start";

const invalidStatus = 400;
const maximumAccountLabelLength = 254;
const State = Schema.Struct({
  handoff_id: Schema.NullOr(Schema.String),
  invitation_id: Schema.NullOr(Schema.String),
  state: Schema.Literals(["pending", "exchanging", "verified", "rejected"]),
});
const InvitationReview = Schema.Struct({
  review_code: Schema.String,
  review_attempt_id: Schema.NullOr(Schema.String),
  review_text: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.Literals(["confirmed", "denied"])),
  attempt_id: Schema.String,
  provider: Schema.Literals(["google", "microsoft"]),
  source_phone: Schema.NullOr(Schema.String),
  contact_email: Schema.NullOr(Schema.String),
  subject: Schema.String,
});
const RetainedReview = Schema.Struct({
  review_code: Schema.String,
  review_text: Schema.String,
  decision: Schema.NullOr(Schema.Literals(["confirmed", "denied"])),
});
type InvitationReviewInput = Readonly<{
  environment: ProviderEnvironment;
  pairingId: string;
  current: number;
  invitationId: string;
}>;
const issueInvitationReview = (
  { environment, pairingId, current, invitationId }: InvitationReviewInput,
  review: typeof InvitationReview.Type,
  accountLabel: string
): Effect.Effect<
  Option.Option<typeof RetainedReview.Type>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const code = review.review_attempt_id === review.attempt_id ? review.review_code : newId();
    const text = `Vincular ${review.provider === "google" ? "Google" : "Microsoft"}: ${accountLabel} [${code}]`;
    if (review.review_attempt_id !== review.attempt_id) {
      yield* Effect.tryPromise(() =>
        environment.DB.prepare(`UPDATE whatsapp_signup_invitations
        SET review_code=?,review_attempt_id=?,review_text=?,review_started_ms=?
        WHERE id=? AND pairing_id=? AND decision IS NULL AND consumed_at_ms IS NULL AND expires_at_ms>? AND (review_attempt_id IS NULL OR review_attempt_id<>?)
        AND EXISTS(SELECT 1 FROM provider_authentication_attempts a WHERE a.id=? AND a.invitation_id=whatsapp_signup_invitations.id AND a.state='verified')`)
          .bind(
            code,
            review.attempt_id,
            text,
            current,
            invitationId,
            pairingId,
            current,
            review.attempt_id,
            review.attempt_id
          )
          .run()
      );
    }
    const issued = yield* Effect.tryPromise(() =>
      environment.DB.prepare(
        `SELECT review_code,review_text,decision FROM whatsapp_signup_invitations
        WHERE id=? AND pairing_id=? AND review_attempt_id=? AND consumed_at_ms IS NULL
        AND approved_at_ms IS NULL AND expires_at_ms>?
        AND EXISTS(SELECT 1 FROM provider_authentication_attempts a WHERE a.id=? AND a.invitation_id=whatsapp_signup_invitations.id AND a.pairing_id=? AND a.state='verified' AND a.expires_at_ms>?)`
      )
        .bind(
          invitationId,
          pairingId,
          review.attempt_id,
          current,
          review.attempt_id,
          pairingId,
          current
        )
        .first()
    );
    return Option.fromNullishOr(
      yield* Schema.decodeUnknownEffect(Schema.NullOr(RetainedReview))(issued)
    );
  });
const invitationReview = ({
  environment,
  pairingId,
  current,
  invitationId,
}: Readonly<{
  environment: ProviderEnvironment;
  pairingId: string;
  current: number;
  invitationId: string;
}>): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      environment.DB.prepare(`SELECT i.review_code,i.review_attempt_id,i.review_text,i.decision,i.source_phone,a.id AS attempt_id,a.provider,a.contact_email,a.subject
        FROM whatsapp_signup_invitations i JOIN provider_authentication_attempts a ON a.invitation_id=i.id AND a.pairing_id=i.pairing_id
        WHERE i.id=? AND i.pairing_id=? AND i.consumed_at_ms IS NULL AND i.approved_at_ms IS NULL AND i.expires_at_ms>? AND a.state='verified' AND a.expires_at_ms>?`)
        .bind(invitationId, pairingId, current, current)
        .first()
    );
    const review = yield* Schema.decodeUnknownEffect(InvitationReview)(raw);
    if (review.decision === "denied") return providerJson({ body: { status: "rejected" } });
    if (review.decision === "confirmed" && review.review_attempt_id === review.attempt_id) {
      return providerJson({ body: { status: "verified" } });
    }
    const accountLabel = (review.contact_email ?? review.subject)
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .slice(0, maximumAccountLabelLength);
    const retained = yield* issueInvitationReview(
      { environment, pairingId, current, invitationId },
      review,
      accountLabel
    );
    if (Option.isNone(retained) || retained.value.decision === "denied") {
      return providerJson({ body: { status: "rejected" } });
    }
    if (retained.value.decision === "confirmed") {
      return providerJson({ body: { status: "verified" } });
    }
    return providerJson({
      body: {
        status: "awaiting_association",
        associationCode: retained.value.review_code,
        confirmationText: retained.value.review_text,
        accountLabel,
        whatsappPhone: review.source_phone,
      },
    });
  });
const publicState = (state: typeof State.Type.state): "pending" | "verified" | "rejected" =>
  state === "verified" || state === "rejected" ? state : "pending";
const resolveStatus = ({
  attempt,
  environment,
  pairingId,
  current,
}: Readonly<{
  attempt: typeof State.Type;
  environment: ProviderEnvironment;
  pairingId: string;
  current: number;
}>): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    if (attempt.handoff_id !== null) {
      const raw = yield* Effect.tryPromise(() =>
        environment.DB.prepare(
          "SELECT decision,review_code FROM whatsapp_provider_handoffs WHERE id=? AND pairing_id=? AND consumed_at_ms IS NULL AND expires_at_ms>?"
        )
          .bind(attempt.handoff_id, pairingId, current)
          .first()
      );
      const handoff = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          decision: Schema.NullOr(Schema.Literals(["confirmed", "denied"])),
          review_code: Schema.String,
        })
      )(raw);
      if (handoff.decision === "denied") return providerJson({ body: { status: "rejected" } });
      if (attempt.state === "verified" && handoff.decision !== "confirmed") {
        return providerJson({
          body: { status: "awaiting_confirmation", associationCode: handoff.review_code },
        });
      }
    }
    if (attempt.invitation_id !== null && attempt.state === "verified") {
      return yield* invitationReview({
        environment,
        pairingId,
        current,
        invitationId: attempt.invitation_id,
      });
    }
    return providerJson({
      body: {
        status: publicState(attempt.state),
      },
    });
  });
export const providerStatus = ({
  request,
  environment,
  provider,
}: Readonly<{
  request: Request;
  environment: ProviderEnvironment;
  provider: AuthenticationProvider;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const proof = yield* boundedJsonBody({
      request,
      policy: providerBodyPolicy,
      schema: ProviderBrowserProof,
    });
    if (Option.isNone(proof)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const refusal = yield* admitProviderPoll({
      db: environment.DB,
      privateVerifier: proof.value.privateVerifier,
    });
    if (Option.isSome(refusal)) return refusal.value;
    const pending = yield* provePendingBrowserPairing({ db: environment.DB, ...proof.value });
    if (Option.isNone(pending)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const current = yield* Clock.currentTimeMillis;
    const row = yield* Effect.tryPromise(() =>
      environment.DB.prepare(
        "SELECT state,handoff_id,invitation_id FROM provider_authentication_attempts WHERE pairing_id=? AND provider=? AND expires_at_ms>?"
      )
        .bind(proof.value.pairingId, provider, current)
        .first()
    );
    const attempt = yield* Schema.decodeUnknownEffect(State)(row);
    return yield* resolveStatus({
      attempt,
      environment,
      pairingId: proof.value.pairingId,
      current,
    });
  }).pipe(
    Effect.orElseSucceed(() => providerJson({ body: { status: "invalid" }, status: invalidStatus }))
  );
