import { Data, type Option } from "effect";

export class PATUnavailable extends Data.TaggedError("PATUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export const nativePATDirectoryUrl = "https://directory.invalid/credentials/pat";

export const localPATClaimUrl = "https://user.invalid/credentials/pat-claim";
