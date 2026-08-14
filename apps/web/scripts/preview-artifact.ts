import { Schema } from "effect";

/** Exact lowercase Git commit identity embedded in a preview artifact. */
export const PreviewGitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u))
  .pipe(Schema.brand("PreviewGitRevision"))
  .annotate({ identifier: "PreviewGitRevision" });
export type PreviewGitRevision = typeof PreviewGitRevision.Type;

/** Exact lowercase canonical-contract digest embedded in a preview artifact. */
export const PreviewContractDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("PreviewContractDigest"))
  .annotate({ identifier: "PreviewContractDigest" });
export type PreviewContractDigest = typeof PreviewContractDigest.Type;

/** Review identity that binds a static artifact to one commit and server contract. */
export const PreviewMetadata = Schema.Struct({
  contractDigest: PreviewContractDigest,
  gitRevision: PreviewGitRevision,
}).annotate({ identifier: "PreviewMetadata" });
export type PreviewMetadata = typeof PreviewMetadata.Type;

const decodeIdentity = <Identity>(
  decode: (candidate: unknown) => Identity,
  candidate: string,
  failureMessage: string
): Identity => {
  try {
    return decode(candidate);
  } catch {
    throw new Error(failureMessage);
  }
};

/**
 * Returns exact preview identity or throws when either lowercase hexadecimal value has the wrong
 * length.
 */
export const previewMetadata = (gitRevision: string, contractDigest: string): PreviewMetadata =>
  Schema.decodeUnknownSync(PreviewMetadata)({
    contractDigest: decodeIdentity(
      Schema.decodeUnknownSync(PreviewContractDigest),
      contractDigest,
      "Preview contract digest must be 64 lowercase hexadecimal characters"
    ),
    gitRevision: decodeIdentity(
      Schema.decodeUnknownSync(PreviewGitRevision),
      gitRevision,
      "Preview Git revision must be 40 lowercase hexadecimal characters"
    ),
  });

/**
 * Reads and packages every regular file below a static output directory; rejects an empty tree and
 * propagates filesystem failures.
 */
export const makePreviewArchive = (directory: string): Promise<Bun.Archive> => {
  const paths = Array.from(
    new Bun.Glob("**/*").scanSync({
      cwd: directory,
      followSymlinks: false,
      onlyFiles: true,
    })
  ).sort();
  if (paths.length === 0) throw new Error("Preview output directory is empty");
  return Promise.all(
    paths.map((path) =>
      Bun.file(`${directory}/${path}`)
        .bytes()
        .then((contents) => [path, contents] as const)
    )
  ).then((entries) => new Bun.Archive(Object.fromEntries(entries)));
};
