import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { MemoryTextInput } from "./model";

const decode = Schema.decodeUnknownSync(MemoryTextInput);

it("normalizes only line endings and outer whitespace in arbitrary Memory prose", () => {
  const prose = "  contraseña: no-la-clasifiques\r\n\r漢字 👩🏽‍💻  ";

  expect(decode(prose)).toBe("contraseña: no-la-clasifiques\n\n漢字 👩🏽‍💻");
});

it("rejects an empty or overlong normalized Memory", () => {
  expect(() => decode(" \r\n ")).toThrow();
  expect(() => decode("x".repeat(2_001))).toThrow();
  expect(decode("x".repeat(2_000))).toHaveLength(2_000);
});
