import { expect, it } from "vitest";
import { Schema } from "effect";
import { CreateKeywordRuleInput, UpdateKeywordRuleInput } from "./contract";

it("accepts rule writes before persistence assigns identity and timestamps", () => {
  const value = { keyword: "cafeteria", categoryId: "10000000-0000-4000-8000-000000000001" };
  for (const codec of [CreateKeywordRuleInput, UpdateKeywordRuleInput]) {
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(value))).toEqual(value);
  }
});
