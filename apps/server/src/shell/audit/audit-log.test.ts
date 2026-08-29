import { UnknownJsonString } from "~/schema-compatibility";
import { expect, layer } from "@effect/vitest";
import assert from "node:assert/strict";
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { MigrationSqlClient } from "~/shell/db/client";
import { type AuditLogEntry, CanonicalOperationId } from "~/core/audit/model";
import { PATId } from "~/core/tokens/reference";
import { WebSessionId } from "~/core/web-session/reference";
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
import { appendAuditLogEntry, observeAuditLogEntries } from "./repo";

/**
 * Names the constraint that refused a write. Asserting the constraint rather than mere failure is
 * what stops a typo in the statement passing for the invariant under test.
 */
const refusedBy = (exit: Exit.Exit<unknown, unknown>): string => {
  assert.ok(Exit.isFailure(exit), "the write must be refused");
  return Cause.pretty(exit.cause);
};

const atomicUserId = UserId.make("f1d1a000-0000-4000-8000-0000000007a1");
const atomicWritePatId = PATId.make("f1d1a000-0000-4000-8000-0000000007a2");
const atomicWriteBearer = TokenBearer.make("fin_atomicw1_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
const atomicObserverBearer = TokenBearer.make(
  "fin_atomicro_abcdefghijklmnopqrstuvwxyz0123456789ABCD"
);
const webSessionId = WebSessionId.make("f1d1a000-0000-4000-8000-0000000007a3");
const encodeTransactionInput = Schema.encodeSync(CreateTransactionInput);

/** Evidence attributed to one PAT. The caller union narrows, so no structural probing is needed. */
const evidenceForPat = (
  entries: ReadonlyArray<AuditLogEntry>,
  patId: PATId
): ReadonlyArray<AuditLogEntry> =>
  entries.filter((entry) => entry.caller._tag === "PAT" && entry.caller.patId === patId);

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
          caller: { _tag: "PAT", patId: defaultPATId },
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
          "caller",
          "id",
          "occurredAt",
          "operation",
          "outcome",
          "subjectUserId",
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
        const canary = "rejected-caller-prose-and-id-canary";

        const response = yield* HttpClient.patch("/user/preferences", {
          headers: { ...headersFor(defaultPatBearer), "x-kapso-contact-id": canary },
          body: HttpBody.jsonUnsafe({ locale: canary, timeZone: "-05:00" }),
        });
        const entries = yield* observeAuditLogEntries(defaultUserId);

        expect(response.status).toBe(400);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          caller: { _tag: "PAT", patId: defaultPATId },
          operation: "identity.updateUserPreferences",
          outcome: "failed",
        });
        expect(DateTime.isUtc(entries[0]?.occurredAt ?? DateTime.makeUnsafe(0))).toBe(true);
        const serialized = yield* Schema.encodeEffect(UnknownJsonString)(entries);
        expect(serialized).not.toContain(canary);
        expect(serialized).not.toContain(defaultPatBearer);
      })
    );

    it.effect("rolls back a state change when its successful evidence cannot commit", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        yield* seedConsentedPatIdentity({
          userId: atomicUserId,
          tokenId: atomicWritePatId,
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
            IF NEW.pat_id = 'f1d1a000-0000-4000-8000-0000000007a2'::uuid
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
          const writeEvidence = evidenceForPat(entries, atomicWritePatId);

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

    it.effect("round-trips metadata-only WebSession caller evidence", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const occurredAt = yield* DateTime.now;

        yield* appendAuditLogEntry(defaultUserId, {
          caller: { _tag: "WebSession", webSessionId },
          operation: CanonicalOperationId.make("identity.getCurrentUser"),
          outcome: "succeeded",
          occurredAt,
        });

        const entries = yield* observeAuditLogEntries(defaultUserId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          subjectUserId: defaultUserId,
          caller: { _tag: "WebSession", webSessionId },
          operation: "identity.getCurrentUser",
          outcome: "succeeded",
          occurredAt,
        });
        expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
          "caller",
          "id",
          "occurredAt",
          "operation",
          "outcome",
          "subjectUserId",
        ]);
      })
    );

    it.effect("refuses evidence that does not name exactly one caller", () =>
      Effect.gen(function* () {
        yield* truncateAuditLogEntries;
        const sql = yield* MigrationSqlClient;
        const append = (
          patId: Option.Option<string>,
          webSessionId: Option.Option<string>,
          hostedAgentSessionId: Option.Option<string>
        ): Effect.Effect<Exit.Exit<unknown, unknown>> =>
          Effect.exit(sql`
            INSERT INTO audit_log_entries (
              user_id, pat_id, web_session_id, hosted_agent_session_id,
              operation, outcome, occurred_at
            )
            VALUES (
              ${defaultUserId}, ${Option.getOrNull(patId)}, ${Option.getOrNull(webSessionId)},
              ${Option.getOrNull(hostedAgentSessionId)},
              'identity.getCurrentUser', 'succeeded', now()
            )
          `);

        // Credential evidence variants are mutually exclusive callers, so evidence naming multiple
        // callers or none would make attribution unreadable rather than merely incomplete.
        const patAndWebSession = yield* append(
          Option.some(defaultPATId),
          Option.some(webSessionId),
          Option.none()
        );
        const webAndHostedSession = yield* append(
          Option.none(),
          Option.some(webSessionId),
          Option.some("f1d1a000-0000-4000-8000-0000000009a1")
        );
        const patAndHostedSession = yield* append(
          Option.some(defaultPATId),
          Option.none(),
          Option.some("f1d1a000-0000-4000-8000-0000000009a1")
        );
        const neither = yield* append(Option.none(), Option.none(), Option.none());

        expect(refusedBy(patAndWebSession)).toContain("audit_log_entries_exactly_one_caller");
        expect(refusedBy(webAndHostedSession)).toContain("audit_log_entries_exactly_one_caller");
        expect(refusedBy(patAndHostedSession)).toContain("audit_log_entries_exactly_one_caller");
        expect(refusedBy(neither)).toContain("audit_log_entries_exactly_one_caller");
        expect(yield* observeAuditLogEntries(defaultUserId)).toEqual([]);
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
          caller: { _tag: "PAT", patId: defaultPATId },
          operation: "transactions.getTransaction",
          outcome: "failed",
        });
        expect(DateTime.isUtc(entries[0]?.occurredAt ?? DateTime.makeUnsafe(0))).toBe(true);
      })
    );
  }
);
