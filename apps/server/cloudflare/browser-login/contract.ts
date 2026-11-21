import { RequestBodyPolicy } from "../http/contract";
import { Schema } from "effect";

export const proofPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});
