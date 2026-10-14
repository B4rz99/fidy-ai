import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveStateBackend } from "./deployment-configuration";

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
