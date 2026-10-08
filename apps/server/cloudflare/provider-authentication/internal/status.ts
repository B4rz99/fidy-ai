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
const State = Schema.Struct({
  handoff_id: Schema.NullOr(Schema.String),
  state: Schema.Literals(["pending", "exchanging", "verified", "rejected"]),
});
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
    return providerJson({
      body: {
        status:
          attempt.state === "verified" || attempt.state === "rejected" ? attempt.state : "pending",
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
    const pending = yield* provePendingBrowserPairing({ db: environment.DB, ...proof.value });
    if (Option.isNone(pending)) {
      return providerJson({ body: { status: "invalid" }, status: invalidStatus });
    }
    const current = yield* Clock.currentTimeMillis;
    const row = yield* Effect.tryPromise(() =>
      environment.DB.prepare(
        "SELECT state,handoff_id FROM provider_authentication_attempts WHERE pairing_id=? AND provider=? AND expires_at_ms>?"
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
