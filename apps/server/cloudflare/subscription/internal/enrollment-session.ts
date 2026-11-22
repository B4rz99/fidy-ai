import {
  paymentEnrollmentInvalidBody,
  paymentEnrollmentRateLimitedBody,
  paymentEnrollmentUnavailableBody,
} from "../../../src/shell/subscription/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import type { sessionDigest } from "../../web-session/operations";
import type { WompiTransportFactory } from "./wompi-runtime";
import type { WompiBindings } from "../contract";

export type NativeEnrollmentEnv = WompiBindings &
  Partial<{ WOMPI_DAVIPLATA_ACTIVATED: string }> & {
    BROWSER_ORIGIN: string;
    PRICING: DurableObjectNamespace;
  };

export const sessionRow = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  time_zone: IanaTimeZone,
  email: Schema.NullOr(Schema.String),
});

export const authorized = Effect.fn(function* (
  digest: Awaited<ReturnType<typeof sessionDigest>>,
  binding: string,
  now: number
) {
  const sql = yield* SqliteClient;

  const guard = protectConsentStatement({
    subject: ConsentSubject.Owner({ column: "s.user_id" }),
    requirement: "active",
    statement: {
      sql: `SELECT s.id,s.user_id,u.time_zone,e.normalized_address AS email FROM web_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN verified_email_credentials e ON e.user_id=s.user_id
      WHERE s.token_digest=? AND s.id=? AND s.revoked_at_ms IS NULL AND s.fresh_until_ms>? AND s.idle_expires_at_ms>? AND s.hard_expires_at_ms>? AND NOT EXISTS(SELECT 1 FROM erasure_requests)`,
      params: [new Uint8Array(digest), binding, now, now, now],
    },
  });

  const [row] = yield* sql.unsafe(guard.sql, guard.params);

  return Schema.decodeUnknownOption(sessionRow)(row);
});

const enrollmentJson = (input: Readonly<{ body: unknown; status: number }>): Response =>
  Response.json(input.body, { status: input.status, headers: { "cache-control": "no-store" } });

export { enrollmentJson as json };

export type EnrollmentSession = typeof sessionRow.Type;

export const liveSession = Effect.fn(function* (session: EnrollmentSession) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const guard = protectConsentStatement({
    subject: ConsentSubject.User({ userId: session.user_id }),
    requirement: "active",
    statement: {
      sql: "SELECT 1 FROM web_sessions WHERE id=? AND user_id=? AND fresh_until_ms>? AND idle_expires_at_ms>? AND hard_expires_at_ms>? AND revoked_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
      params: [session.id, session.user_id, now, now, now],
    },
  });

  return (yield* sql.unsafe(guard.sql, guard.params)).length === 1;
});

export type EnrollmentContext = Readonly<{
  env: NativeEnrollmentEnv;
  storage: DurableObjectStorage;
  transport: WompiTransportFactory;
}>;

export type BrowserEnrollment = EnrollmentContext &
  Readonly<{ request: Request; session: EnrollmentSession }>;

export const invalidEnrollment = (): Response =>
  Response.json(paymentEnrollmentInvalidBody, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });

export const unavailableEnrollment = (): Response =>
  Response.json(paymentEnrollmentUnavailableBody, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });

export const limitedEnrollment = (): Response =>
  Response.json(paymentEnrollmentRateLimitedBody, {
    status: 429,
    headers: { "cache-control": "no-store" },
  });

export const unauthorizedEnrollment = (): Response =>
  Response.json(paymentEnrollmentInvalidBody, {
    status: 401,
    headers: { "cache-control": "no-store" },
  });
