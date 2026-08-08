import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema } from "effect";
import { UtcTimestamp } from "./time";

const decode = Schema.decodeUnknownResult(UtcTimestamp);
const encode = Schema.encodeSync(UtcTimestamp);

it("reads an offset spelling and a UTC spelling as the same instant", () => {
  const withOffset = decode("2026-03-14T09:30:00-05:00");
  const asUtc = decode("2026-03-14T14:30:00Z");

  expect(Result.isSuccess(withOffset) ? DateTime.toEpochMillis(withOffset.success) : 0).toBe(
    Result.isSuccess(asUtc) ? DateTime.toEpochMillis(asUtc.success) : -1
  );
});

it("rejects text that names no instant", () => {
  for (const text of ["", "yesterday", "2026-13-01T00:00:00Z"]) {
    expect(Result.isFailure(decode(text))).toBe(true);
  }
});

it("rejects a spelling that leaves the instant to be guessed at", () => {
  for (const text of [
    "2026",
    "2026-03",
    "2026-03-14",
    "March 14, 2026 GMT",
    "2026-03-14T14:30:00",
  ]) {
    expect(Result.isFailure(decode(text))).toBe(true);
  }
});

it("encodes an instant back to its UTC spelling rather than the caller's", () => {
  const decoded = decode("2026-03-14T09:30:00-05:00");

  expect(Result.isSuccess(decoded) ? encode(decoded.success) : "").toBe("2026-03-14T14:30:00.000Z");
});

it("documents itself to a calling agent as a date-time string", () => {
  const document = Schema.toJsonSchemaDocument(UtcTimestamp);

  expect(document.definitions.UtcTimestamp).toMatchObject({
    type: "string",
    format: "date-time",
  });
});
