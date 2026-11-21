import { Schema } from "effect";
import { RequestBodyPolicy } from "../../http/contract";

export const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
