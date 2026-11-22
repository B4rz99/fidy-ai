import { Effect, Option } from "effect";
import type { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { checkSmokeExchange, exchangeSmoke } from "./smoke-exchange";

type StablePair = Readonly<{
  public: SmokeIdentity;
  core: SmokeIdentity;
  proof: string;
}>;

export const verifyStableWorkerIdentity = Effect.fn(function* (
  expected: StablePair,
  origin = "https://api.fidyapp.com"
) {
  const observed = yield* exchangeSmoke(
    {
      query: "?readiness=1",
      headers: { "x-fidy-smoke-proof": expected.proof },
      body: Option.none(),
    },
    origin
  );

  yield* checkSmokeExchange(observed, {
    public: expected.public,
    core: expected.core,
    replayIdentity: false,
  });
});
