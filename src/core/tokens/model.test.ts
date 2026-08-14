import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { HostedTurnTokenId, PATId } from "./reference";
import {
  HostedTurnScopes,
  PatScopes,
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

it("accepts exactly eight lowercase alphanumeric characters as the TokenBearer short id", () => {
  const decodeShortId = Schema.decodeUnknownResult(TokenShortId);

  expect(Result.isSuccess(decodeShortId("default1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("xdefault1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("default1x"))).toBe(true);
  expect(Result.isFailure(decodeShortId("DEFAULT1!"))).toBe(true);
  expect(Result.isFailure(decodeShortId("d"))).toBe(true);
});

it("accepts exactly the non-empty unique TokenBearer scope vocabulary", () => {
  const decodeScopes = Schema.decodeUnknownResult(PatScopes);

  expect(Result.isSuccess(decodeScopes(["read", "write", "dashboard"]))).toBe(true);
  expect(Result.isFailure(decodeScopes([]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "read"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["admin"]))).toBe(true);
});

it("requires every canonical scope for an internal HostedTurnToken", () => {
  const decodeScopes = Schema.decodeUnknownResult(HostedTurnScopes);

  expect(Result.isSuccess(decodeScopes(["read", "write", "dashboard"]))).toBe(true);
  expect(Result.isSuccess(decodeScopes(["dashboard", "read", "write"]))).toBe(true);
  expect(Result.isFailure(decodeScopes([]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "write"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "write", "write"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "write", "admin"]))).toBe(true);
});

it("documents the hosted scope set as one array rather than a variant per ordering", () => {
  const document = Schema.toJsonSchemaDocument(HostedTurnScopes);

  expect(document.definitions.HostedTurnScopes).toMatchObject({ type: "array" });
});

it("rejects HostedTurnToken use and revocation outside its hard lifetime", () => {
  const decodeToken = Schema.decodeUnknownResult(Schema.toType(TokenGrant));
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const expiresAt = DateTime.addDuration(createdAt, "15 minutes");
  const usedAt = DateTime.addDuration(createdAt, "1 minute");
  const validToken = {
    _tag: "HostedTurnToken" as const,
    id: HostedTurnTokenId.make("f1d1a000-0000-4000-8000-000000000011"),
    shortId: TokenShortId.make("hosted01"),
    scopes: HostedTurnScopes.make(["read", "write", "dashboard"]),
    lastUsedAt: Option.some(usedAt),
    expiresAt,
    revokedAt: Option.some(usedAt),
    createdAt,
  };

  const invalidExpiry = decodeToken({ ...validToken, expiresAt: createdAt });
  const invalidEarlyUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(DateTime.subtractDuration(createdAt, "1 millis")),
    revokedAt: Option.none(),
  });
  const invalidLateUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(expiresAt),
    revokedAt: Option.none(),
  });
  const invalidRevocation = decodeToken({
    ...validToken,
    revokedAt: Option.some(createdAt),
  });

  expect(Result.isSuccess(decodeToken(validToken))).toBe(true);
  expect(
    Result.isSuccess(
      decodeToken({ ...validToken, lastUsedAt: Option.none(), revokedAt: Option.none() })
    )
  ).toBe(true);
  expect(Result.isFailure(invalidExpiry)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidExpiry)))).toContain('at ["expiresAt"]');
  expect(Result.isFailure(invalidEarlyUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidEarlyUse)))).toContain(
    'at ["lastUsedAt"]'
  );
  expect(Result.isFailure(invalidLateUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidLateUse)))).toContain(
    'at ["lastUsedAt"]'
  );
  expect(Result.isFailure(invalidRevocation)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidRevocation)))).toContain(
    'at ["revokedAt"]'
  );
});

it("carries bearer grant instants over the wire as date-time strings", () => {
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const encoded = Schema.encodeSync(TokenGrant)({
    _tag: "PAT",
    id: PATId.make("f1d1a000-0000-4000-8000-000000000010"),
    shortId: TokenShortId.make("default1"),
    scopes: PatScopes.make(["read"]),
    lastUsedAt: Option.none(),
    idleExpiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  });

  expect(encoded.createdAt).toBe("2026-07-28T12:34:56.000Z");
  expect(Result.isSuccess(Schema.decodeUnknownResult(TokenGrant)(encoded))).toBe(true);
});

it("rejects PAT timestamps outside lifecycle order", () => {
  const decodeToken = Schema.decodeUnknownResult(Schema.toType(TokenGrant));
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const validToken = {
    _tag: "PAT" as const,
    id: PATId.make("f1d1a000-0000-4000-8000-000000000010"),
    shortId: TokenShortId.make("default1"),
    scopes: PatScopes.make(["read"]),
    lastUsedAt: Option.none(),
    idleExpiresAt: DateTime.addDuration(createdAt, "90 days"),
    revokedAt: Option.none(),
    createdAt,
  };

  const usedAt = DateTime.addDuration(createdAt, "1 day");
  const invalidIdleExpiry = decodeToken({ ...validToken, idleExpiresAt: createdAt });
  const invalidEarlyUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(DateTime.subtractDuration(createdAt, "1 millis")),
  });
  const invalidUnrenewedUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(usedAt),
  });
  const invalidRevocation = decodeToken({
    ...validToken,
    revokedAt: Option.some(DateTime.subtractDuration(createdAt, "1 millis")),
  });
  const invalidRevocationBeforeUse = decodeToken({
    ...validToken,
    lastUsedAt: Option.some(usedAt),
    idleExpiresAt: DateTime.addDuration(usedAt, "90 days"),
    revokedAt: Option.some(createdAt),
  });

  expect(Result.isSuccess(decodeToken(validToken))).toBe(true);
  expect(
    Result.isSuccess(
      decodeToken({
        ...validToken,
        lastUsedAt: Option.some(createdAt),
        revokedAt: Option.some(createdAt),
      })
    )
  ).toBe(true);
  expect(
    Result.isSuccess(
      decodeToken({
        ...validToken,
        lastUsedAt: Option.some(usedAt),
        idleExpiresAt: DateTime.addDuration(usedAt, "90 days"),
        revokedAt: Option.some(usedAt),
      })
    )
  ).toBe(true);
  expect(Result.isFailure(invalidIdleExpiry)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidIdleExpiry)))).toContain(
    'at ["idleExpiresAt"]'
  );
  expect(Result.isFailure(invalidEarlyUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidEarlyUse)))).toContain(
    'at ["lastUsedAt"]'
  );
  expect(Result.isFailure(invalidUnrenewedUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidUnrenewedUse)))).toContain(
    'at ["idleExpiresAt"]'
  );
  expect(Result.isFailure(invalidRevocation)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidRevocation)))).toContain(
    'at ["revokedAt"]'
  );
  expect(Result.isFailure(invalidRevocationBeforeUse)).toBe(true);
  expect(String(Option.getOrThrow(Result.getFailure(invalidRevocationBeforeUse)))).toContain(
    'at ["revokedAt"]'
  );
});
