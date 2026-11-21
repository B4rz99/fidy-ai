import { Schema } from "effect";

export const GitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u))
  .pipe(Schema.brand("GitRevision"))
  .annotate({ identifier: "GitRevision" });

export type GitRevision = typeof GitRevision.Type;

export const ContractDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("ContractDigest"))
  .annotate({ identifier: "ContractDigest" });

export type ContractDigest = typeof ContractDigest.Type;

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

type ReleaseMetadataOptions = Readonly<{ gitRevision: string; contractDigest: string }>;

export const releaseMetadata = ({
  gitRevision,
  contractDigest,
}: ReleaseMetadataOptions): ReleaseMetadata =>
  Schema.decodeSync(ReleaseMetadata)({
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
