import { Option } from "effect";
import { expect, it } from "vitest";
import { shouldCompactConversation, terminalPrefixCursor } from "./operations";

it("compacts at either independent capacity boundary", () => {
  expect(shouldCompactConversation({ entryCount: 79, tokenCount: 99_999 })).toBe(false);
  expect(shouldCompactConversation({ entryCount: 80, tokenCount: 0 })).toBe(true);
  expect(shouldCompactConversation({ entryCount: 0, tokenCount: 100_000 })).toBe(true);
});

it("selects the terminal prefix before pending work, including an empty or entirely terminal transcript", () => {
  expect(terminalPrefixCursor([])).toEqual(Option.none());
  expect(terminalPrefixCursor([{ sequence: 10, status: "pending" }])).toEqual(Option.none());
  const terminal = [
    { sequence: 10, status: "completed" },
    { sequence: 20, status: "failed" },
    { sequence: 30, status: "interrupted" },
  ] as const;
  expect(terminalPrefixCursor(terminal)).toEqual(Option.some(30));
  expect(
    terminalPrefixCursor([
      ...terminal,
      { sequence: 40, status: "pending" },
      { sequence: 50, status: "completed" },
    ])
  ).toEqual(Option.some(30));
  expect(terminalPrefixCursor([{ sequence: 0, status: "completed" }])).toEqual(Option.some(0));
});
