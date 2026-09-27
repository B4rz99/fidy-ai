import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Cause, Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { validateProductionArtifact } from "../cloudflare/production-policy/artifact";
import { releaseMetadata } from "./release-metadata";

const gitRevision = "0123456789abcdef0123456789abcdef01234567";
const contractDigest = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const temporaryDirectories: Array<string> = [];
const encodeMetadata = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ contractDigest: Schema.String, gitRevision: Schema.String })
  )
);

// Vitest owns teardown; keep every directory registered even when fixture construction fails.
afterEach(() =>
  Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
);

const productionOutput = (
  assetName = "app-AbCd1234.js"
): Effect.Effect<string, Cause.UnknownError> =>
  Effect.gen(function* () {
    const directory = yield* Effect.tryPromise(() => mkdtemp("/tmp/fidy-production-artifact-"));
    temporaryDirectories.push(directory);
    yield* Effect.tryPromise(() => mkdir(join(directory, "assets")));
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(directory, "index.html"),
        `<!doctype html><script type="module" src="/assets/${assetName}"></script>`
      )
    );
    yield* Effect.tryPromise(() =>
      Bun.write(join(directory, "_headers"), "/*\n  X-Frame-Options: DENY\n")
    );
    yield* Effect.tryPromise(() =>
      Bun.write(
        join(directory, "deployment-metadata.json"),
        `${encodeMetadata({ contractDigest, gitRevision })}\n`
      )
    );
    yield* Effect.tryPromise(() =>
      Bun.write(join(directory, `assets/${assetName}`), "console.log('web')")
    );
    return directory;
  });

const validate = (directory: string): Promise<void> =>
  validateProductionArtifact({
    directory,
    expectedDigest: contractDigest,
    expectedSha: gitRevision,
  });

describe("production static release identity", () => {
  it("binds one static artifact to a full Git revision and canonical contract digest", () => {
    expect(releaseMetadata({ gitRevision, contractDigest })).toEqual({
      contractDigest,
      gitRevision,
    });
  });

  it("rejects abbreviated or non-hexadecimal release identity", () => {
    expect(() => releaseMetadata({ gitRevision: "HEAD", contractDigest })).toThrow(
      "Git revision must be 40 lowercase hexadecimal characters"
    );
    expect(() => releaseMetadata({ gitRevision, contractDigest: "digest" })).toThrow(
      "Contract digest must be 64 lowercase hexadecimal characters"
    );
  });

  it.effect("accepts only a static artifact with the expected release identity", () =>
    Effect.gen(function* () {
      const directory = yield* productionOutput();
      yield* Effect.tryPromise(() => expect(validate(directory)).resolves.toBeUndefined());
    })
  );

  it.effect("rejects an unhashed browser asset", () =>
    Effect.gen(function* () {
      const directory = yield* productionOutput("app.js");
      yield* Effect.tryPromise(() => expect(validate(directory)).rejects.toThrow("content-hashed"));
    })
  );

  it.effect("rejects a shell whose hashed entry asset is missing", () =>
    Effect.gen(function* () {
      const directory = yield* productionOutput();
      yield* Effect.tryPromise(() => rm(join(directory, "assets"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        expect(validate(directory)).rejects.toThrow("missing hashed asset")
      );
    })
  );

  it.effect("rejects server code from the production artifact", () =>
    Effect.gen(function* () {
      const directory = yield* productionOutput();
      yield* Effect.tryPromise(() =>
        Bun.write(join(directory, "assets/server.js"), "RESEND_API_KEY")
      );
      yield* Effect.tryPromise(() =>
        expect(validate(directory)).rejects.toThrow("forbidden production artifact path")
      );
    })
  );

  it.effect("rejects source maps from the production artifact", () =>
    Effect.gen(function* () {
      const directory = yield* productionOutput();
      yield* Effect.tryPromise(() =>
        Bun.write(join(directory, "assets/app-AbCd1234.js.map"), "{}")
      );
      yield* Effect.tryPromise(() =>
        expect(validate(directory)).rejects.toThrow("forbidden production artifact path")
      );
    })
  );
});
