import { ConsentSubject } from "../../../src/shell/consent/contract";
import { protectConsentAuthority } from "../../../src/shell/consent/operations";
import { Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { WebSessionId } from "../../../src/core/web-session/contract";
import type { AuthenticatedWebSession, BoundWebSessionLookup } from "../contract";

const Session = Schema.Struct({ id: WebSessionId, userId: UserId });

export const decodeSessionLookup = ({
  lookup,
  row,
}: Readonly<{
  lookup: BoundWebSessionLookup;
  row: unknown;
}>): Option.Option<AuthenticatedWebSession> =>
  Option.map(Schema.decodeUnknownOption(Session)(row), (session) => ({
    ...session,
    digest: lookup.digest,
  }));

export const sessionDigestLookup = ({
  digest,
  current,
  freshness,
  requireConsent,
  binding,
}: Readonly<{
  digest: Uint8Array;
  current: number;
  freshness: "live" | "fresh";
  requireConsent: boolean;
  binding: Option.Option<string>;
}>): BoundWebSessionLookup => {
  const requested = {
    table: "web_sessions" as const,
    predicate: `token_digest = ? AND revoked_at_ms IS NULL ${freshness === "fresh" ? "AND fresh_until_ms > ?" : ""}
          AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
          ${Option.isSome(binding) ? "AND id = ?" : ""}`,
    bindings: [
      [digest],
      freshness === "fresh" ? [current] : [],
      [current, current],
      Option.toArray(binding),
    ].flat(),
  };

  const authority = requireConsent
    ? protectConsentAuthority({
        authority: requested,
        subject: ConsentSubject.Owner({ column: "web_sessions.user_id" }),
        requirement: "unrevoked",
      })
    : requested;

  return {
    digest,
    authority,
    statement: {
      sql: `SELECT id, user_id AS userId FROM web_sessions WHERE ${authority.predicate}`,
      params: authority.bindings,
    },
  };
};
