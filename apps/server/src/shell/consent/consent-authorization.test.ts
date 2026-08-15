import { expect, layer } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import { UserId } from "~/core/identity/reference";
import { CreateTransactionInput } from "~/core/transactions/model";
import { TokenBearer } from "~/core/tokens/model";
import { observeAuditLogEntries } from "~/shell/audit/repo";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { appendConsentRecord, observeConsentRecords, withSubjectLock } from "./repo";
import { ApiHarness, headersFor } from "~/shell/testing/api-harness";
import { transactionPayload, truncateTransactions } from "~/shell/transactions/fixtures";

const unconsentedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008a1");
const unconsentedBearer = TokenBearer.make("fin_noconsnt_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const revokedUserId = UserId.make("f1d1a000-0000-4000-8000-0000000008a2");
const revokedBearer = TokenBearer.make("fin_revokrac_abcdefghijklmnopqrstuvwxyz0123456789ABCD");

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "canonical consent enforcement",
  (it) => {
    it.effect("rejects before canonical financial execution and audit", () =>
      Effect.gen(function* () {
        yield* seedConsentedPatIdentity({
          userId: unconsentedUserId,
          bearer: unconsentedBearer,
          scopes: ["write"],
        });
        const sql = yield* SqlClient.SqlClient;
        const admin = yield* MigrationSqlClient;
        yield* truncateTransactions;
        yield* admin`DELETE FROM audit_log_entries WHERE user_id = ${unconsentedUserId}`;
        yield* admin`DELETE FROM consent_records WHERE subject_user_id = ${unconsentedUserId}`;

        const TokenUseState = Schema.Struct({
          lastUsedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
          idleExpiresAt: Schema.DateTimeUtcFromDate,
        });
        const readTokenUse = SqlSchema.findOne({
          Request: UserId,
          Result: TokenUseState,
          execute: (userId) => sql`
            SELECT last_used_at AS "lastUsedAt", idle_expires_at AS "idleExpiresAt"
            FROM tokens WHERE user_id = ${userId}
          `,
        });
        const tokenUseBefore = yield* withUserTransaction(
          unconsentedUserId,
          readTokenUse(unconsentedUserId)
        );

        const payload = yield* Schema.encodeEffect(CreateTransactionInput)(
          transactionPayload({ counterparty: "Must never persist" })
        ).pipe(Effect.orDie);
        const response = yield* HttpClient.post("/transactions", {
          headers: headersFor(unconsentedBearer),
          body: HttpBody.jsonUnsafe(payload),
        });
        const body = yield* response.json;
        const Count = Schema.Struct({ count: Schema.Int });
        const transactions = yield* withUserTransaction(
          unconsentedUserId,
          SqlSchema.findOne({
            Request: UserId,
            Result: Count,
            execute: (userId) => sql`
              SELECT count(*)::int AS count FROM transactions WHERE user_id = ${userId}
            `,
          })(unconsentedUserId)
        );
        const tokenUseAfter = yield* withUserTransaction(
          unconsentedUserId,
          readTokenUse(unconsentedUserId)
        );
        const audits = yield* observeAuditLogEntries(unconsentedUserId);

        expect(response.status).toBe(403);
        expect(body).toMatchObject({ error: { code: "consent_required" } });
        expect(transactions.count).toBe(0);
        expect(tokenUseAfter).toEqual(tokenUseBefore);
        expect(Option.isNone(tokenUseAfter.lastUsedAt)).toBe(true);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          subjectUserId: unconsentedUserId,
          operation: "transactions.createTransaction",
          outcome: "rejected",
        });
      })
    );

    it.effect("does not execute when a concurrent revocation wins authorization", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const admin = yield* MigrationSqlClient;
        yield* admin`DELETE FROM transactions WHERE user_id = ${revokedUserId}`;
        yield* admin`DELETE FROM audit_log_entries WHERE user_id = ${revokedUserId}`;
        yield* admin`DELETE FROM consent_records WHERE subject_user_id = ${revokedUserId}`;
        yield* admin`DELETE FROM tokens WHERE user_id = ${revokedUserId}`;
        yield* admin`DELETE FROM users WHERE id = ${revokedUserId}`;
        yield* seedConsentedPatIdentity({
          userId: revokedUserId,
          bearer: revokedBearer,
          scopes: ["write"],
        });
        const [grant] = yield* observeConsentRecords(revokedUserId);
        if (grant === undefined) return yield* Effect.die("missing onboarding grant");

        const lockAcquired = yield* Deferred.make<void>();
        const commitRevocation = yield* Deferred.make<void>();
        const revocation = ConsentRecord.make({
          ...grant,
          id: ConsentRecordId.make("f1d1a000-0000-4000-8000-0000000008a2"),
          event: { _tag: "Revoked", grantId: grant.id },
          occurredAt: DateTime.makeUnsafe("2026-08-02T15:00:00Z"),
          decisionMessage: {
            channel: "whatsapp",
            provider: "kapso",
            providerMessageId: "wamid.concurrent-revocation",
          },
        });
        const revocationFiber = yield* withSubjectLock(
          revokedUserId,
          Effect.gen(function* () {
            yield* Deferred.succeed(lockAcquired, undefined);
            yield* Deferred.await(commitRevocation);
            yield* appendConsentRecord(revocation);
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(lockAcquired);

        const payload = yield* Schema.encodeEffect(CreateTransactionInput)(
          transactionPayload({ counterparty: "Must lose revocation race" })
        ).pipe(Effect.orDie);
        const requestFiber = yield* HttpClient.post("/transactions", {
          headers: headersFor(revokedBearer),
          body: HttpBody.jsonUnsafe(payload),
        }).pipe(Effect.forkChild);
        yield* Deferred.succeed(commitRevocation, undefined);
        yield* Fiber.join(revocationFiber);
        const response = yield* Fiber.join(requestFiber);
        const body = yield* response.json;
        const rows = yield* withUserTransaction(
          revokedUserId,
          sql`SELECT id FROM transactions WHERE user_id = ${revokedUserId}`
        );

        expect(response.status).toBe(403);
        expect(body).toMatchObject({ error: { code: "consent_required" } });
        expect(rows).toHaveLength(0);
      })
    );
  }
);
