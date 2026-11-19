import { answerFixturePayment } from "./internal/payments";
import { Effect } from "effect";
import type { AcceptanceProviderEnvironment } from "./contract";
import { answerFixtureIdentity } from "./internal/identity";
/** Strictly private provider transport for the closed installed release. Unknown destinations have no fallback. */
export const acceptanceProviderResponse = Effect.fn(
  function* (request: Request, env: AcceptanceProviderEnvironment) {
    if (env.NATIVE_STORAGE_ADMISSION !== "closed") return new Response(null, { status: 403 });
    if (new URL(request.url).origin === "https://sandbox.wompi.co") {
      return yield* answerFixturePayment(request, env);
    }
    return yield* answerFixtureIdentity(request, env);
  },
  Effect.orElseSucceed(() => new Response(null, { status: 503 }))
);
