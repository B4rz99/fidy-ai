import { Data, Effect, FileSystem, Option, Redacted, Schema } from "effect";
import { tmpdir } from "node:os";

export class VerificationFailure extends Data.TaggedError("VerificationFailure")<{
  readonly message: string;
  readonly cause: Option.Option<Redacted.Redacted<unknown>>;
}> {}

const attempt = Effect.fn(function <Value>(
  message: string,
  run: () => Promise<Value>
): Effect.Effect<Value, VerificationFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new VerificationFailure({ message, cause: Option.some(Redacted.make(cause)) }),
  });
});

export const budgetCategories = {
  codex: "10000000-0000-4000-8000-000000000006",
  claude: "10000000-0000-4000-8000-000000000007",
} as const;

const PRIVATE_DIRECTORY_MODE = 0o700;

export const privateDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const root = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ directory: tmpdir(), prefix: "fidy-mcp-proof-" }).pipe(
      Effect.tap((root) => fs.chmod(root, PRIVATE_DIRECTORY_MODE)),
      Effect.mapError(
        (cause) =>
          new VerificationFailure({
            message: "Cannot create private verification directory",
            cause: Option.some(Redacted.make(cause)),
          })
      )
    ),
    (root) => fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
  );

  return yield* fs.realPath(root).pipe(
    Effect.mapError(
      (cause) =>
        new VerificationFailure({
          message: "Cannot resolve private verification directory",
          cause: Option.some(Redacted.make(cause)),
        })
    )
  );
});

export const requireCheck = Effect.fn(function (
  passed: boolean,
  message: string
): Effect.Effect<void, VerificationFailure> {
  return passed
    ? Effect.void
    : Effect.fail(new VerificationFailure({ message, cause: Option.none() }));
});

export const readJson = Effect.fn(function <Value>(
  codec: Schema.Codec<Value>,
  path: string
): Effect.Effect<Value, VerificationFailure> {
  return attempt<unknown>("Cannot read private verification state", () =>
    Bun.file(path).json()
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(codec)),
    Effect.mapError(
      (cause) =>
        new VerificationFailure({
          message: "Invalid verification state",
          cause: Option.some(Redacted.make(cause)),
        })
    )
  );
});

export const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);
