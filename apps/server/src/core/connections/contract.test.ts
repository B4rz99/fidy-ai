import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import {
  BrowserContinuation,
  ConnectInstitutionResult,
  InstitutionId,
  InstitutionSummary,
} from "./contract";

it("bounds institution identities to a leading lowercase letter and a short ASCII slug", () => {
  const decode = Schema.decodeUnknownResult(InstitutionId);
  for (const value of ["a", "z", "bank-09", "a".repeat(64)]) {
    expect(Result.isSuccess(decode(value))).toBe(true);
  }
  for (const value of [
    "",
    "a".repeat(65),
    "9bank",
    "-bank",
    "Bank",
    "bank_name",
    "bánk",
    "bank.name",
    "bank\n",
  ]) {
    expect(Result.isFailure(decode(value))).toBe(true);
  }
});

it("accepts only the fixed first-party connection continuation URL", () => {
  const decode = Schema.decodeUnknownResult(BrowserContinuation);
  const reference = "10000000-0000-4000-8000-000000000001";
  const url = `https://app.fidyapp.com/connections/continue?attempt=${reference}`;
  const value = { url, expiresAt: "2026-10-22T12:00:00Z" };
  expect(Result.isSuccess(decode(value))).toBe(true);
  for (const candidate of [
    url.replace("https:", "http:"),
    url.replace("app.fidyapp.com", "appXfidyappYcom"),
    url.replace("app.fidyapp.com", "evil.example"),
    url.replace("/connections/continue", "/other"),
    `${url}&extra=1`,
    `${url}x`,
    `x${url}`,
    url.slice(0, -1),
    url.replace(reference, "z".repeat(36)),
    url.replace("?attempt=", "?other="),
  ]) {
    expect(Result.isFailure(decode({ ...value, url: candidate }))).toBe(true);
  }
});

it("retains the caller's current Connection projection through discovery and browser handoff", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  for (const connection of [null, { id, state: "Active" }]) {
    const value = { id: "bank", displayName: "Banco", availability: "available", connection };
    expect(
      Schema.encodeSync(InstitutionSummary)(Schema.decodeUnknownSync(InstitutionSummary)(value))
    ).toEqual(value);
  }
  for (const value of [
    { type: "already_connected", connection: { id, institutionId: "bank", state: "Active" } },
    {
      type: "continue_in_browser",
      connection: { id, institutionId: "bank", state: "Connecting" },
      continuation: {
        url: `https://app.fidyapp.com/connections/continue?attempt=${id}`,
        expiresAt: "2026-10-22T12:00:00.000Z",
      },
    },
  ]) {
    expect(
      Schema.encodeSync(ConnectInstitutionResult)(
        Schema.decodeUnknownSync(ConnectInstitutionResult)(value)
      )
    ).toEqual(value);
  }
});
