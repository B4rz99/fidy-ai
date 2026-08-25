import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import { WebSessionBearer } from "./reference";

const decodeBearer = Schema.decodeUnknownResult(WebSessionBearer);
const validBearer = "A".repeat(43);

it("accepts exactly 43 base64url characters as a WebSession bearer", () => {
  expect(Result.isSuccess(decodeBearer(validBearer))).toBe(true);
});

it("rejects a WebSession bearer with an invalid leading character", () => {
  expect(Result.isFailure(decodeBearer(`!${validBearer}`))).toBe(true);
});

it("rejects a WebSession bearer with an invalid trailing character", () => {
  expect(Result.isFailure(decodeBearer(`${validBearer}!`))).toBe(true);
});

it("rejects a WebSession bearer made entirely of characters outside the base64url alphabet", () => {
  expect(Result.isFailure(decodeBearer("!".repeat(43)))).toBe(true);
});

it("rejects WebSession bearers shorter or longer than 43 characters", () => {
  expect(Result.isFailure(decodeBearer(validBearer.slice(0, 42)))).toBe(true);
  expect(Result.isFailure(decodeBearer(`${validBearer}A`))).toBe(true);
});
