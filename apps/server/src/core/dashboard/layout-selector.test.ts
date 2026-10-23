import { expect, it } from "vitest";
import { Result, Schema } from "effect";
import { LayoutRegionSelector } from "./contract";

it("accepts every in-order identity of a compound layout region", () => {
  const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
  expect(Schema.decodeUnknownSync(LayoutRegionSelector)(ids)).toEqual(ids);
});

it("validates every identity in a compound region rather than only its first identity", () => {
  expect(
    Result.isFailure(
      Schema.decodeResult(LayoutRegionSelector)([
        "10000000-0000-4000-8000-000000000001",
        "not-a-uuid",
      ])
    )
  ).toBe(true);
});

it("requires at least one Widget identity when selecting a layout region", () => {
  expect(Result.isFailure(Schema.decodeUnknownResult(LayoutRegionSelector)([]))).toBe(true);
});
