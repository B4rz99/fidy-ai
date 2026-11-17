import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect, Layer, Schema } from "effect";
import { resolveDeploymentConfiguration } from "./deployment-configuration";
import { buildStorageRelease, storageReleaseCodec } from "./storage-release";
import { closedInstallation, nativeStack } from "./storage-installation";

const state = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Alchemy.ALCHEMY_DEV) ? Alchemy.localState() : Cloudflare.state();
  }).pipe(Effect.orDie)
);
export default Alchemy.Stack(
  nativeStack,
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const development = yield* Alchemy.ALCHEMY_DEV;
    const stage = yield* Alchemy.Stage;
    const release = yield* Effect.fromResult(
      resolveDeploymentConfiguration({
        development,
        stage,
        gitRevision: development ? "" : yield* Config.String("RELEASE_GIT_SHA"),
        contractDigest: development ? "" : yield* Config.String("CONTRACT_DIGEST"),
        releaseAttemptId: development ? "" : yield* Config.String("RELEASE_ATTEMPT_ID"),
      })
    ).pipe(Effect.orDie);
    const storage = yield* buildStorageRelease().pipe(
      Effect.flatMap(Schema.encodeEffect(storageReleaseCodec)),
      Effect.orDie
    );
    return yield* closedInstallation({
      development,
      release,
      storage,
      smokeProof: yield* Config.Redacted("SMOKE_PROOF"),
      ceiling: yield* Config.String("SQLITE_STORE_CAPACITY_BYTES").pipe(
        Config.withDefault("1000000000")
      ),
    });
  })
);
