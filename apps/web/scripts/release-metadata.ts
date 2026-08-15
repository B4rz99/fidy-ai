import { Schema } from "effect";

/** Exact lowercase Git commit identity embedded in a deployed static artifact. */
export const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u))
  .pipe(Schema.brand("GitRevision"))
  .annotate({ identifier: "GitRevision" });
export type GitRevision = typeof GitRevision.Type;

/** Exact lowercase canonical-contract digest embedded in a deployed static artifact. */
export const ContractDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("ContractDigest"))
  .annotate({ identifier: "ContractDigest" });
export type ContractDigest = typeof ContractDigest.Type;

/** Public diagnostic identity binding one static artifact to its server contract. */
export const ReleaseMetadata = Schema.Struct({
  contractDigest: ContractDigest,
  gitRevision: GitRevision,
}).annotate({ identifier: "ReleaseMetadata" });
export type ReleaseMetadata = typeof ReleaseMetadata.Type;

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

/** Returns an exact release identity or throws when either value is not full lowercase hex. */
export const releaseMetadata = (gitRevision: string, contractDigest: string): ReleaseMetadata =>
  Schema.decodeUnknownSync(ReleaseMetadata)({
    contractDigest: decodeIdentity(
      Schema.decodeUnknownSync(ContractDigest),
      contractDigest,
      "Contract digest must be 64 lowercase hexadecimal characters"
    ),
    gitRevision: decodeIdentity(
      Schema.decodeUnknownSync(GitRevision),
      gitRevision,
      "Git revision must be 40 lowercase hexadecimal characters"
    ),
  });
