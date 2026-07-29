import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { UserId } from "./user";

const decodeUserId = Schema.decodeUnknownResult(UserId);

it("rejects an owner id that is not a UUID", () => {
  expect(Result.isFailure(decodeUserId("el-corral"))).toBe(true);
});
