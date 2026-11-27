import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import { productionTopology } from "../../apps/server/cloudflare/runtime/contract";
import { freeTierWorkerObservability } from "./worker-observability";

export const marketingSite = Effect.fn(function* (revision: string, production: boolean) {
  return yield* Cloudflare.Website.StaticSite("Site", {
    name: productionTopology.site.workerName,
    main: "../../apps/site/cloudflare/worker.ts",
    observability: freeTierWorkerObservability,
    command: "bun run build:production",
    cwd: "../../apps/site",
    outdir: "dist",
    env: { RELEASE_GIT_SHA: revision },
    dev: {
      command: `bun run dev -- --host 127.0.0.1 --port ${productionTopology.site.localPort}`,
      cwd: "../../apps/site",
    },
    assets: {
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: ["/*", "!/_astro/*", "!/*.png", "!/*.webp"],
    },
    domain: production ? productionTopology.site.hostname : undefined,
    workersDev: false,
  });
});
