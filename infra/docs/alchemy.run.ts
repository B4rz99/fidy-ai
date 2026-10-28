import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";

const state = Layer.unwrap(
  Effect.map(Alchemy.Stage, (stage) =>
    stage === "production" ? Cloudflare.state() : Alchemy.inMemoryState()
  )
);

export default Alchemy.Stack(
  "FidyDocs",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    yield* Schema.decodeUnknownEffect(Schema.Literal("production"))(stage).pipe(
      Effect.mapError((cause) => new Config.ConfigError(cause))
    );
    const docs = yield* Cloudflare.Website.StaticSite("Docs", {
      name: "fidy-docs",
      memo: false,
      command: "bun run build",
      cwd: "../../apps/docs",
      outdir: "dist",
      assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page" },
      domain: "docs.fidyapp.com",
      workersDev: false,
      observability: { enabled: false },
    });
    return { docsUrl: docs.url };
  })
);
