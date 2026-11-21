import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer } from "effect";
import { marketingSite } from "./marketing-site";

export default Alchemy.Stack(
  "FidyCloudflare",
  {
    providers: Cloudflare.providers(),
    state: Layer.unwrap(
      Effect.map(Alchemy.Stage, (stage) =>
        stage === "production" ? Cloudflare.state() : Alchemy.inMemoryState()
      )
    ),
  },
  Effect.gen(function* () {
    yield* Config.Literal("marketing-only", "SITE_PUBLICATION");
    const site = yield* marketingSite(yield* Config.String("RELEASE_GIT_SHA"), true);

    return { siteUrl: site.url };
  })
);
