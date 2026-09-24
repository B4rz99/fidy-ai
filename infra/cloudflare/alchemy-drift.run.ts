import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveStateBackend } from "./deployment-configuration";

/**
 * Inspects the persisted Production stack without importing runtime bindings. Drift compares saved
 * resource attributes with live Cloudflare resources, so this entrypoint needs only the same state
 * backend selection and provider registry as the deployment entrypoint.
 */
const state = Layer.unwrap(
  Effect.gen(function* () {
    const development = yield* Alchemy.ALCHEMY_DEV;
    const stage = yield* Alchemy.Stage;
    const backend = resolveStateBackend({ development, stage });

    if (backend === "cloudflare") return Cloudflare.state();
    if (backend === "local") return Alchemy.localState();
    return Alchemy.inMemoryState();
  }).pipe(Effect.orDie)
);

export default Alchemy.Stack(
  "FidyCloudflare",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.succeed({})
);
