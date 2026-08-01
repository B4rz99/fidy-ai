import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import { AgentTokenId } from "./reference";
import {
  AgentBearerSecret,
  AgentBearerToken,
  AgentToken,
  AgentTokenScopes,
  AgentTokenShortId,
  HostedAgentScopes,
  getAgentTokenShortId,
  makeAgentBearerToken,
} from "./model";

const decodeBearer = Schema.decodeUnknownResult(AgentBearerToken);

it("accepts only opaque AgentToken bearers with the fin_ prefix and short token id", () => {
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

it.effect("builds and reads the AgentToken bearer through one encoding contract", () =>
  Effect.gen(function* () {
    const shortId = AgentTokenShortId.make("default1");
    const secret = AgentBearerSecret.make("0123456789abcdefghijklmnopqrstuvwxyzABCD");
    const bearer = yield* makeAgentBearerToken({ shortId, secret });
    const extracted = yield* getAgentTokenShortId(bearer);

    expect(bearer).toBe("fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD");
    expect(extracted).toBe(shortId);
  })
);

it("accepts exactly eight lowercase alphanumeric characters as the AgentToken short id", () => {
  const decodeShortId = Schema.decodeUnknownResult(AgentTokenShortId);

  expect(Result.isSuccess(decodeShortId("default1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("xdefault1"))).toBe(true);
  expect(Result.isFailure(decodeShortId("default1x"))).toBe(true);
  expect(Result.isFailure(decodeShortId("DEFAULT1!"))).toBe(true);
  expect(Result.isFailure(decodeShortId("d"))).toBe(true);
});

it("accepts exactly the non-empty unique AgentToken scope vocabulary", () => {
  const decodeScopes = Schema.decodeUnknownResult(AgentTokenScopes);

  expect(Result.isSuccess(decodeScopes(["read", "write", "dashboard"]))).toBe(true);
  expect(Result.isFailure(decodeScopes([]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "read"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["admin"]))).toBe(true);
});

it("requires every canonical scope for an internal HostedAgentToken", () => {
  const decodeScopes = Schema.decodeUnknownResult(HostedAgentScopes);

  expect(Result.isSuccess(decodeScopes(["read", "write", "dashboard"]))).toBe(true);
  expect(Result.isSuccess(decodeScopes(["dashboard", "read", "write"]))).toBe(true);
  expect(Result.isFailure(decodeScopes(["read", "write"]))).toBe(true);
});

it("rejects HostedAgentToken use and revocation outside its hard lifetime", () => {
  const decodeToken = Schema.decodeUnknownResult(AgentToken);
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const expiresAt = DateTime.addDuration(createdAt, "15 minutes");
  const usedAt = DateTime.addDuration(createdAt, "1 minute");
  const validToken = {
    _tag: "HostedAgentToken" as const,
    id: AgentTokenId.make("f1d1a000-0000-4000-8000-000000000011"),
    shortId: AgentTokenShortId.make("hosted01"),
    scopes: HostedAgentScopes.make(["read", "write", "dashboard"]),
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

it("rejects UserAgentToken timestamps outside lifecycle order", () => {
  const decodeToken = Schema.decodeUnknownResult(AgentToken);
  const createdAt = DateTime.makeUnsafe("2026-07-28T12:34:56Z");
  const validToken = {
    _tag: "UserAgentToken" as const,
    id: AgentTokenId.make("f1d1a000-0000-4000-8000-000000000010"),
    shortId: AgentTokenShortId.make("default1"),
    scopes: AgentTokenScopes.make(["read"]),
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
