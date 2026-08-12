import { expect, it } from "@effect/vitest";
import { DateTime, Result, Schema } from "effect";
import { UtcTimestamp } from "./time";

const decode = Schema.decodeUnknownResult(UtcTimestamp);
const encode = Schema.encodeSync(UtcTimestamp);
const validateType = Schema.decodeUnknownResult(Schema.toType(UtcTimestamp));

it("reads an offset spelling and a UTC spelling as the same instant", () => {
  const withOffset = decode("2026-03-14T09:30:00-05:00");
  const asUtc = decode("2026-03-14T14:30:00Z");

  expect(Result.isSuccess(withOffset) ? DateTime.toEpochMillis(withOffset.success) : 0).toBe(
    Result.isSuccess(asUtc) ? DateTime.toEpochMillis(asUtc.success) : -1
  );
});

it("rejects text that names no PostgreSQL instant", () => {
  for (const text of ["", "yesterday", "0000-01-01T00:00:00Z", "2026-13-01T00:00:00Z"]) {
    expect(Result.isFailure(decode(text))).toBe(true);
  }
});

it("rejects PostgreSQL-invalid in-memory instants at the domain boundary", () => {
  for (const value of [
    DateTime.makeUnsafe("0000-01-01T00:00:00Z"),
    DateTime.makeUnsafe("+010000-01-01T00:00:00Z"),
  ]) {
    expect(Result.isFailure(validateType(value))).toBe(true);
  }
});

it("accepts the last valid day in months with 30 or 31 days", () => {
  for (const text of ["2026-04-30T00:00:00Z", "2026-03-31T00:00:00Z"]) {
    expect(Result.isSuccess(decode(text))).toBe(true);
  }
});

it("accepts PostgreSQL timezone offsets through +15:59", () => {
  expect(Result.isSuccess(decode("2026-03-14T09:30:00+15:59"))).toBe(true);
});

it("rejects timezone offsets outside PostgreSQL's displacement range", () => {
  expect(Result.isFailure(decode("2026-03-14T09:30:00+16:00"))).toBe(true);
  expect(Result.isFailure(decode("2026-03-14T09:30:00-16:00"))).toBe(true);
});

it("rejects a positive timezone offset beyond +23:59", () => {
  expect(Result.isFailure(decode("2026-03-14T09:30:00+24:00"))).toBe(true);
});

it("rejects junk before or after an otherwise valid instant spelling", () => {
  for (const text of [
    "prefix2026-03-14T09:30:00Z",
    "2026-03-14T09:30:00Zsuffix",
    "+002026-03-14T09:30:00Z",
    "2026-03-14T09:30:00Z\u0000",
  ]) {
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
