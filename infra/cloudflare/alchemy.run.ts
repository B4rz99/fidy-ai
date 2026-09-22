import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { productionTopology } from "./topology";

const developmentGitRevision = "0000000000000000000000000000000000000000";
const developmentContractDigest =
  "0000000000000000000000000000000000000000000000000000000000000000";

const releaseGitRevision = Config.String("RELEASE_GIT_SHA").pipe(
  Config.withDefault(developmentGitRevision)
);
const contractDigest = Config.String("CONTRACT_DIGEST").pipe(
  Config.withDefault(developmentContractDigest)
);

const state = Layer.unwrap(
  Alchemy.ALCHEMY_DEV.pipe(
    Effect.orDie,
    Effect.map((development) => (development ? Alchemy.localState() : Cloudflare.state()))
  )
);

export default Alchemy.Stack(
  "FidyCloudflare",
  {
    providers: Cloudflare.providers(),
    state,
  },
  Effect.gen(function* () {
    const production = yield* Alchemy.Stack.useSync((stack) => stack.stage === "production");

    const core = yield* Cloudflare.Worker("Core", {
      main: "./core-worker.ts",
      compatibility: { date: "2026-09-08" },
      env: {
        CONTRACT_DIGEST: contractDigest,
        RELEASE_GIT_SHA: releaseGitRevision,
      },
      workersDev: productionTopology.core.workersDev,
    });

    const ingress = yield* Cloudflare.Worker("Ingress", {
      main: "./public-worker.ts",
      compatibility: { date: "2026-09-08" },
      domain: production ? productionTopology.ingress.hostname : undefined,
      env: { [productionTopology.ingress.coreBinding]: core },
      workersDev: production ? productionTopology.ingress.workersDev : true,
    });

    const web = yield* Cloudflare.Website.StaticSite("Web", {
      command: "bun run build:production",
      cwd: "../../apps/web",
      outdir: "dist",
      env: {
        CONTRACT_DIGEST: contractDigest,
        RELEASE_GIT_SHA: releaseGitRevision,
      },
      dev: {
        command: "bun run dev -- --host 127.0.0.1",
        cwd: "../../apps/web",
      },
      assets: {
        htmlHandling: "none",
        notFoundHandling: "single-page-application",
      },
      domain: production
        ? {
            name: productionTopology.web.hostname,
            redirects: [...productionTopology.web.redirects],
          }
        : undefined,
      workersDev: production ? productionTopology.web.workersDev : true,
    });

    return {
      apiUrl: ingress.url,
      webUrl: web.url,
    };
  })
);
