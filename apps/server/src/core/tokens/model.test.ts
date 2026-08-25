import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { PATId } from "./reference";
import {
  ManualPATGrantInput,
  PATLifetimeDays,
  PATRecipientLabel,
  PATScopes,
  ResolvedToken,
  TokenBearer,
  TokenGrant,
  TokenSecret,
  TokenShortId,
  getTokenShortId,
  makeTokenBearer,
} from "./model";

const decodeBearer = Schema.decodeUnknownResult(TokenBearer);

it("accepts only opaque TokenBearer bearers with the fin_ prefix and short token id", () => {
  expect(
    Result.isSuccess(decodeBearer("fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"))
  ).toBe(true);
  expect(Result.isFailure(decodeBearer("default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"))).toBe(
    true
  );
  expect(Result.isFailure(decodeBearer("fin_short_secret"))).toBe(true);
  expect(
    Result.isFailure(decodeBearer("xfin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"))
  ).toBe(true);
  expect(
    Result.isFailure(decodeBearer("fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD!"))
  ).toBe(true);
});

it.effect("builds and reads the TokenBearer bearer through one encoding contract", () =>
  Effect.gen(function* () {
    const shortId = TokenShortId.make("default1");
    const secret = TokenSecret.make("0123456789abcdefghijklmnopqrstuvwxyzABCD");
    const bearer = yield* makeTokenBearer({ shortId, secret });
    const extracted = yield* getTokenShortId(bearer);

    expect(bearer).toBe("fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD");
    expect(extracted).toBe(shortId);
  })
);

it("accepts PAT identity in resolved authorization facts", () => {
  expect(
    Result.isSuccess(
      Schema.decodeUnknownResult(ResolvedToken)({
        tokenId: "f1d1a000-0000-4000-8000-000000000012",
        subjectUserId: "f1d1a000-0000-4000-8000-000000000013",
        scopes: ["read"],
        lastUsedAt: "2026-07-28T12:34:56Z",
      })
    )
  ).toBe(true);
});

it("accepts exactly eight lowercase alphanumeric characters as the TokenBearer short id", () => {
  const decodeShortId = Schema.decodeUnknownResult(TokenShortId);

  expect(Result.isSuccess(decodeShortId("default1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("xdefault1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("default1x"))).toBe(true);
  expect(Result.isFailure(decodeShortId("DEFAULT1!"))).toBe(true);
  expect(Result.isFailure(decodeShortId("d"))).toBe(true);
});

it("accepts exactly the non-empty unique TokenBearer scope vocabulary", () => {
  const decodeScopes = Schema.decodeUnknownResult(PATScopes);

  expect(Result.isSuccess(decodeScopes(["read", "write", "dashboard"]))).toBe(true);
  expect(Result.isFailure(decodeScopes([]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "read"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["admin"]))).toBe(true);
});

it("normalizes one manual PAT recipient label before enforcing the grant boundary", () => {
  const decodeGrant = Schema.decodeUnknownResult(ManualPATGrantInput);
  const accepted = decodeGrant({
    recipientLabel: "  Automatización casa  ",
    scopes: ["read"],
    lifetimeDays: 90,
  });

  expect(Result.getOrThrow(accepted)).toEqual({
    recipientLabel: PATRecipientLabel.make("Automatización casa"),
    scopes: ["read"],
    lifetimeDays: 90,
  });
  expect(
    Result.isFailure(decodeGrant({ recipientLabel: "   ", scopes: ["read"], lifetimeDays: 90 }))
  ).toBe(true);
  expect(
    Result.isSuccess(
      decodeGrant({ recipientLabel: "🧭".repeat(80), scopes: ["read"], lifetimeDays: 7 })
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      decodeGrant({ recipientLabel: "🧭".repeat(81), scopes: ["read"], lifetimeDays: 365 })
    )
  ).toBe(true);
  expect(
    Result.isFailure(decodeGrant({ recipientLabel: "Agente", scopes: [], lifetimeDays: 30 }))
  ).toBe(true);
});

it("accepts only the four fixed PAT lifetime presets", () => {
  const decodeLifetime = Schema.decodeUnknownResult(PATLifetimeDays);

  expect([7, 30, 90, 365].map((days) => Result.isSuccess(decodeLifetime(days)))).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(Result.isFailure(decodeLifetime(0))).toBe(true);
  expect(Result.isFailure(decodeLifetime(91))).toBe(true);
});

it("carries bearer grant instants over the wire as date-time strings", () => {
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const encoded = Schema.encodeSync(TokenGrant)({
    _tag: "PAT",
    id: PATId.make("f1d1a000-0000-4000-8000-000000000010"),
    shortId: TokenShortId.make("default1"),
    recipientLabel: PATRecipientLabel.make("Agente de prueba"),
    scopes: PATScopes.make(["read"]),
    lifetimeDays: 90,
    lastUsedAt: Option.none(),
    expiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  });

  expect(encoded.createdAt).toBe("2026-07-28T12:34:56.000Z");
  expect(Result.isSuccess(Schema.decodeUnknownResult(TokenGrant)(encoded))).toBe(true);
});

it("keeps fixed PAT expiration independent from successful use", () => {
  const decodeToken = Schema.decodeUnknownResult(Schema.toType(TokenGrant));
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const validToken = {
    _tag: "PAT" as const,
    id: PATId.make("f1d1a000-0000-4000-8000-000000000010"),
    shortId: TokenShortId.make("default1"),
    recipientLabel: PATRecipientLabel.make("Agente de prueba"),
    scopes: PATScopes.make(["read"]),
    lifetimeDays: 90 as const,
    lastUsedAt: Option.none(),
    expiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  };

  const usedAt = DateTime.addDuration(createdAt, "1 day");
  const validReviewedExpiry = decodeToken({
    ...validToken,
    expiresAt: DateTime.subtractDuration(validToken.expiresAt, "1 minute"),
  });
  const invalidExpiry = decodeToken({ ...validToken, expiresAt: createdAt });
  const invalidExtendedExpiry = decodeToken({
    ...validToken,
    expiresAt: DateTime.addDuration(validToken.expiresAt, "1 millis"),
  });
  const invalidEarlyUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(DateTime.subtractDuration(createdAt, "1 millis")),
  });
  const validUseWithoutRenewal = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(usedAt),
  });
  const invalidRevocationBeforeUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(usedAt),
    revokedAt: Option.some(createdAt),
  });

  expect(Result.isSuccess(decodeToken(validToken))).toBe(true);
  expect(Result.isSuccess(validUseWithoutRenewal)).toBe(true);
  expect(Result.isSuccess(validReviewedExpiry)).toBe(true);
  expect(Result.isFailure(invalidExpiry)).toBe(true);
  expect(Result.isFailure(invalidExtendedExpiry)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidExpiry)))).toContain('at ["expiresAt"]');
  expect(Result.isFailure(invalidEarlyUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidEarlyUse)))).toContain(
    'at ["lastUsedAt"]'
  );
  expect(Result.isFailure(invalidRevocationBeforeUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidRevocationBeforeUse)))).toContain(
    'at ["revokedAt"]'
  );
});
