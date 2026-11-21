import { Data } from "effect";

export class IdentityUnavailable extends Data.TaggedError("IdentityUnavailable")<{}> {}
