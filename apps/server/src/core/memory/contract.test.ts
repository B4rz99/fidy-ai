import {
  MemoryCapacityExceeded,
  MemoryNotFound,
  MemoryText,
  MemoryTextInput,
  RememberInput,
  ReviseInput,
} from "./contract";
import { expect, it } from "@effect/vitest";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(MemoryTextInput);

it("normalizes only line endings and outer whitespace in arbitrary Memory prose", () => {
  const prose = "  contraseña: no-la-clasifiques\r\n\r漢字 👩🏽‍💻  ";

  expect(decode(prose)).toBe("contraseña: no-la-clasifiques\n\n漢字 👩🏽‍💻");
});

it("encodes normalized Memory prose without changing its canonical text", () => {
  const text = MemoryText.make("canonical prose");

  expect(Schema.encodeSync(MemoryTextInput)(text)).toBe("canonical prose");
});

it("derives both Memory write inputs from the normalized text boundary", () => {
  for (const schema of [RememberInput, ReviseInput]) {
    expect(Schema.is(schema)({ text: "a durable fact" })).toBe(true);
    expect(Schema.is(schema)({ text: " " })).toBe(false);
  }
});

it("rejects an empty or overlong normalized Memory", () => {
  expect(() => decode(" \r\n ")).toThrow();
  expect(() => decode("x".repeat(2_001))).toThrow();
  expect(decode("x".repeat(2_000))).toHaveLength(2_000);
});

it("explains capacity and absence failures without including Memory content", () => {
  expect(new MemoryCapacityExceeded().message).toBe(
    "The User's current Memories have reached their aggregate token capacity"
  );
  expect(new MemoryNotFound().message).toBe("No current Memory belongs to the User");
});
