import { expect, layer } from "@effect/vitest";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MigrationSqlClient } from "~/shell/db/client";
import { PATId, type TokenId } from "~/core/tokens/reference";
import { IanaTimeZone } from "~/core/_shared/context";
import { UserId } from "~/core/identity/reference";
import { CreateTransactionInput, TransactionId } from "~/core/transactions/model";
import { TokenBearer } from "~/core/tokens/model";
import {
  defaultPATId,
  defaultUserId,
  defaultWhatsAppPhone,
  seedConsentedPatIdentity,
} from "~/shell/db/development-seed";
import {
  type ApiClient,
  ApiHarness,
  ApiHarnessClient,
  headersFor,
  makeApiClientLive,
} from "~/shell/testing/api-harness";
import { defaultPatBearer } from "~/shell/testing/identity-fixtures";
import { transactionPayload } from "~/shell/transactions/fixtures";
import { truncateAuditLogEntries } from "./fixtures";
import { observeAuditLogEntries } from "./repo";

const atomicUserId = UserId.make("f1d1a000-0000-4000-8000-0000000007a1");
const atomicWriteTokenId = PATId.make("f1d1a000-0000-4000-8000-0000000007a2");
const atomicWriteBearer = TokenBearer.make("fin_atomicw1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const atomicObserverBearer = TokenBearer.make(
  "fin_atomicro_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const encodeTransactionInput = Schema.encodeSync(CreateTransactionInput);
const evidenceForToken = <Entry extends { readonly tokenId: TokenId }>(
  entries: ReadonlyArray<Entry>,
  tokenId: TokenId
): ReadonlyArray<Entry> => entries.filter((entry) => entry.tokenId === tokenId);

class AtomicObserverApiClient extends Context.Service<AtomicObserverApiClient, ApiClient>()(
  "@fidy/server/shell/audit/audit-log.test/AtomicObserverApiClient"
) {}

const AuditHarness = makeApiClientLive({
  tag: AtomicObserverApiClient,
  bearer: atomicObserverBearer,
}).pipe(Layer.provideMerge(ApiHarness));

layer(AuditHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "canonical operation auditing",
  (it) => {
    it.effect("appends metadata-only evidence for a successful canonical operation", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;

        const startedAt = yield* DateTime.now;
        yield* client.identity.getCurrentUser();
        const finishedAt = yield* DateTime.now;

        const entries = yield* observeAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          tokenId: defaultPATId,
          operation: "identity.getCurrentUser",
          outcome: "succeeded",
        });
        const [entry] = entries;
        if (entry === undefined) return yield* Effect.die("missing AuditLogEntry");
        expect(DateTime.isUtc(entry.occurredAt)).toBe(true);
        expect(DateTime.toEpochMillis(entry.occurredAt)).toBeGreaterThanOrEqual(
          DateTime.toEpochMillis(startedAt)
        );
        expect(DateTime.toEpochMillis(entry.occurredAt)).toBeLessThanOrEqual(
          DateTime.toEpochMillis(finishedAt)
        );
        expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
          "id",
          "occurredAt",
          "operation",
          "outcome",
          "subjectUserId",
          "tokenId",
        ]);
        expect(Object.values(entry)).not.toContain(defaultPatBearer);
      })
    );

    it.effect("appends successful evidence for a User preference mutation", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;

        const response = yield* HttpClient.patch("/user/preferences", {
          headers: {
            ...headersFor(defaultPatBearer),
            "x-kapso-contact-id": "provider-contact-private-42",
          },
          body: HttpBody.jsonUnsafe({
            locale: "es-CO",
            timeZone: IanaTimeZone.make("America/New_York"),
          }),
        });
        const entries = yield* observeAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(response.status).toBe(200);
        expect(entries[0]).toMatchObject({
          operation: "identity.updateUserPreferences",
          outcome: "succeeded",
        });
        const persistedValues = Object.values(entries[0] ?? {});
        expect(persistedValues).not.toContain(defaultWhatsAppPhone);
        expect(persistedValues).not.toContain("whatsapp");
        expect(persistedValues).not.toContain("provider-contact-private-42");
        expect(persistedValues).not.toContain(defaultPatBearer);
        expect(persistedValues).not.toContain("es-CO");
        expect(persistedValues).not.toContain("America/New_York");
      })
    );

    it.effect("appends failed evidence when canonical input is rejected", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;

        const response = yield* HttpClient.patch("/user/preferences", {
          headers: headersFor(defaultPatBearer),
          body: HttpBody.jsonUnsafe({ locale: "es-CO", timeZone: "-05:00" }),
        });
        const entries = yield* observeAuditLogEntries(defaultUserId);

        expect(response.status).toBe(400);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          tokenId: defaultPATId,
          operation: "identity.updateUserPreferences",
          outcome: "failed",
        });
        expect(DateTime.isUtc(entries[0]?.occurredAt ?? DateTime.makeUnsafe(0))).toBe(true);
      })
    );

    it.effect("rolls back a state change when its successful evidence cannot commit", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        yield* seedConsentedPatIdentity({
          userId: atomicUserId,
          tokenId: atomicWriteTokenId,
          bearer: atomicWriteBearer,
          scopes: ["write"],
        });
        yield* seedConsentedPatIdentity({
          userId: atomicUserId,
          bearer: atomicObserverBearer,
          scopes: ["read"],
        });
        const sql = yield* MigrationSqlClient;
        const observer = yield* AtomicObserverApiClient;
        yield* sql`
          CREATE OR REPLACE FUNCTION reject_atomic_success_audit()
          RETURNS trigger AS $$
          BEGIN
            IF NEW.token_id = 'f1d1a000-0000-4000-8000-0000000007a2'::uuid
              AND NEW.outcome = 'succeeded' THEN
              RAISE EXCEPTION 'injected successful-audit failure';
            END IF;
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql
        `;
        yield* sql`DROP TRIGGER IF EXISTS reject_atomic_success_audit ON audit_log_entries`;
        yield* sql`
          CREATE TRIGGER reject_atomic_success_audit
          BEFORE INSERT ON audit_log_entries
          FOR EACH ROW EXECUTE FUNCTION reject_atomic_success_audit()
        `;
        const removeFailureInjection = sql`
          DROP TRIGGER IF EXISTS reject_atomic_success_audit ON audit_log_entries
        `.pipe(
          Effect.andThen(sql`DROP FUNCTION IF EXISTS reject_atomic_success_audit()`),
          Effect.orDie
        );

        yield* Effect.gen(function* () {
          const response = yield* HttpClient.post("/transactions", {
            headers: headersFor(atomicWriteBearer),
            body: HttpBody.jsonUnsafe(
              encodeTransactionInput(transactionPayload({ counterparty: "Atomic private body" }))
            ),
          });
          const history = yield* observer.transactions.listTransactions({ query: {} });
          const entries = yield* observeAuditLogEntries(atomicUserId);
          const writeEvidence = evidenceForToken(entries, atomicWriteTokenId);

          expect(response.status).toBe(500);
          expect(history.data).toEqual([]);
          expect(writeEvidence).toHaveLength(1);
          expect(writeEvidence[0]).toMatchObject({
            subjectUserId: atomicUserId,
            operation: "transactions.createTransaction",
            outcome: "failed",
          });
        }).pipe(Effect.ensuring(removeFailureInjection));
      })
    );

    it.effect("appends exactly one failed entry for a declared canonical failure", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const client = yield* ApiHarnessClient;
        const absentId = TransactionId.make("018f6b77-6f9f-7b2d-8000-000000000099");

        const failure = yield* Effect.flip(
          client.transactions.getTransaction({ params: { id: absentId } })
        );
        expect(failure).toMatchObject({ error: { code: "not_found" } });

        const entries = yield* observeAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          tokenId: defaultPATId,
          operation: "transactions.getTransaction",
          outcome: "failed",
        });
        expect(DateTime.isUtc(entries[0]?.occurredAt ?? DateTime.makeUnsafe(0))).toBe(true);
      })
    );
  }
);
