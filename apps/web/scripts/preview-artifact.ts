import { type ReleaseMetadata, releaseMetadata } from "./release-metadata";

/** Review identity that binds a static artifact to one commit and server contract. */
export type PreviewMetadata = ReleaseMetadata;

/** Returns exact preview identity with preview-specific diagnostic failures. */
export const previewMetadata = (gitRevision: string, contractDigest: string): PreviewMetadata => {
  try {
    return releaseMetadata(gitRevision, contractDigest);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Git revision")) {
      throw new Error("Preview Git revision must be 40 lowercase hexadecimal characters");
    }
    throw new Error("Preview contract digest must be 64 lowercase hexadecimal characters");
  }
};

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
