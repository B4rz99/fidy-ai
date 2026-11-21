import { Data } from "effect";

export class PATUnavailable extends Data.TaggedError("PATUnavailable") {}

export const nativePATDirectoryUrl = "https://directory.invalid/credentials/pat";

export const localPATClaimUrl = "https://user.invalid/credentials/pat-claim";
