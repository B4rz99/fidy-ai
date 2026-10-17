import { Effect, Option } from "effect";
import type { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { checkSmokeExchange, exchangeSmoke } from "./smoke-exchange";

type StablePair = Readonly<{ public: SmokeIdentity; core: SmokeIdentity; proof: string }>;
/** Prove normal-traffic identities without admitting work before capturing a rollback baseline. */
export const verifyStableWorkerIdentity = Effect.fn(function* (expected: StablePair) {
  const observed = yield* exchangeSmoke({
    query: "?readiness=1",
    headers: { "x-fidy-smoke-proof": expected.proof },
    body: Option.none(),
  });
  yield* checkSmokeExchange(observed, {
    public: expected.public,
    core: expected.core,
    replayIdentity: false,
  });
});
