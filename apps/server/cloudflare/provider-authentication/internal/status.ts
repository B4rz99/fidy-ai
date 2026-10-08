import { Clock, Effect, Option, Schema } from "effect";
import { ProviderBrowserProof } from "../../../src/shell/provider-authentication/contract";
import { provePendingBrowserPairing } from "../../browser-login/operations";
import { boundedJsonBody } from "../../http/operations";
import type { GoogleEnvironment } from "../contract";
import { providerBodyPolicy, providerJson } from "./start";

const invalidStatus = 400;
const State = Schema.Struct({
  state: Schema.Literals(["pending", "exchanging", "verified", "rejected"]),
});
export const providerStatus = ({
  request,
  environment,
}: Readonly<{ request: Request; environment: GoogleEnvironment }>): Effect.Effect<Response> =>
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
        "SELECT state FROM provider_authentication_attempts WHERE pairing_id=? AND expires_at_ms>?"
      )
        .bind(proof.value.pairingId, current)
        .first()
    );
    const attempt = yield* Schema.decodeUnknownEffect(State)(row);
    return providerJson({
      body: {
        status:
          attempt.state === "verified" || attempt.state === "rejected" ? attempt.state : "pending",
      },
    });
  }).pipe(
    Effect.orElseSucceed(() => providerJson({ body: { status: "invalid" }, status: invalidStatus }))
  );
