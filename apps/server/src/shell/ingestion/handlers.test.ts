import { expect, layer } from "@effect/vitest";
import { Context, Crypto, Effect, Encoding, Layer, Result, Schema } from "effect";
import { UserId } from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import {
  Base64FileContent,
  StatementIdempotencyKey,
  type SubmitForExtractionInput,
} from "~/core/ingestion/model";
import { PaywallRequired, ValidationFailed } from "~/shell/_shared/errors";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { MigrationSqlClient } from "~/shell/db/client";
import { seedConsentedPatIdentity } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { type ApiClient, ApiHarness, makeApiClientLive } from "~/shell/testing/api-harness";
import { truncateStatementIngestion } from "./fixtures";
import { enableEmailForwardingInScope, submitForExtractionInScope } from "./mutations";

const freeUserId = UserId.make("f1d1a000-0000-4000-8000-00000000c181");
const freeTokenId = PATId.make("f1d1a000-0000-4000-8000-00000000c182");
const freeBearer = TokenBearer.make("fin_ingest01_abcdefghijklmnopqrstuvwxyz0123456789ABCD");
class FreeApiClient extends Context.Service<FreeApiClient, ApiClient>()(
  "@fidy/server/shell/ingestion/handlers.test/FreeApiClient"
) {}
const IngestionHarness = makeApiClientLive({ tag: FreeApiClient, bearer: freeBearer }).pipe(
  Layer.provideMerge(ApiHarness)
);

const controlledEntropy = { nextByte: 0, latestByte: 0 };
const controlledCrypto = Crypto.make({
  randomBytes: (size) => {
    controlledEntropy.nextByte = (controlledEntropy.nextByte + 1) % 256;
    controlledEntropy.latestByte = controlledEntropy.nextByte;
    return new Uint8Array(size).fill(controlledEntropy.latestByte);
  },
  digest: (algorithm, data) =>
    Effect.promise(() =>
      globalThis.crypto.subtle
        .digest(algorithm, Uint8Array.from(data))
        .then((buffer) =>
          Uint8Array.from(new Uint8Array(buffer), (value, index) =>
            index === 0 ? value ^ 0xff : value
          )
        )
    ),
});
const controlledUuid = (entropyByte: number): string => {
  const byte = entropyByte.toString(16).padStart(2, "0");
  const variant = ((entropyByte & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${byte.repeat(4)}-${byte.repeat(2)}-4${byte[1]}${byte}-${variant}${byte}-${byte.repeat(6)}`;
};

const bytesPerMebibyte = 1024 * 1024;
const oversizedStatementBytes = 5 * bytesPerMebibyte + 1;

const statementPayload = (idempotencyKey: string): SubmitForExtractionInput => ({
  idempotencyKey: StatementIdempotencyKey.make(idempotencyKey),
  file: {
    name: "statement.csv",
    declaredMediaType: "text/csv",
    contentBase64: Base64FileContent.make(
      Encoding.encodeBase64("Date,Amount,Description,Type\n2020-02-05,25000,Mercado,DEBIT\n")
    ),
  },
});

layer(IngestionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "ingestion cryptography",
  (it) => {
    it.effect("obtains persisted identifiers, forwarding entropy, and digests from Crypto", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        yield* seedConsentedPatIdentity({
          userId: freeUserId,
          bearer: freeBearer,
          tokenId: freeTokenId,
          scopes: ["read", "write"],
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`DELETE FROM email_forwarding_addresses WHERE user_id = ${freeUserId}`;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${freeUserId}`;

        const result = yield* withUserTransaction(
          freeUserId,
          Effect.gen(function* () {
            const forwarding = yield* enableEmailForwardingInScope(freeUserId);
            const forwardingEntropy = controlledEntropy.latestByte;
            const submissionInput = {
              userId: freeUserId,
              caller: freePatCaller(["write"]),
              payload: statementPayload("f1d1a000-0000-4000-8000-00000000c188"),
            } as const;
            const submitted = yield* submitForExtractionInScope(submissionInput);
            const resubmitted = yield* submitForExtractionInScope(submissionInput);
            return { forwarding, forwardingEntropy, submitted, resubmitted };
          })
        ).pipe(Effect.provideService(Crypto.Crypto, controlledCrypto));

        expect(result.forwarding.data.address).toBe(
          `${Encoding.encodeBase64Url(new Uint8Array(24).fill(result.forwardingEntropy)).toLocaleLowerCase("en-US")}@ingest.fidyapp.com`
        );
        const forwardingRows = yield* sql`
          SELECT id::text AS id FROM email_forwarding_addresses WHERE user_id = ${freeUserId}
        `;
        expect(forwardingRows).toEqual([
          { id: controlledUuid((result.forwardingEntropy + 255) % 256) },
        ]);

        expect(result.submitted.data.id).toBe(controlledUuid(controlledEntropy.latestByte));
        expect(result.resubmitted.data.id).toBe(result.submitted.data.id);
        const submissionRows = yield* sql`
          SELECT content_hash AS "contentHash" FROM statement_submissions
          WHERE id = ${result.submitted.data.id}
        `;
        expect(submissionRows).toEqual([
          { contentHash: "2671c17831ee0061bf737859315496e13e734b93529fea78e23096df1215b9ca" },
        ]);
      })
    );
  }
);

layer(IngestionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement ingestion operations",
  (it) => {
    it.effect("bounds outstanding files per stable User", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        yield* seedConsentedPatIdentity({
          userId: freeUserId,
          bearer: freeBearer,
          tokenId: freeTokenId,
          scopes: ["read", "write"],
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`UPDATE users SET paid_tier = 'pro' WHERE id = ${freeUserId}`;
        const client = yield* FreeApiClient;
        const burst = yield* Effect.all(
          Array.from({ length: 6 }, (_, index) =>
            Effect.result(
              client.ingestion.submitForExtraction({
                payload: statementPayload(`f1d1a000-0000-4000-8000-00000000d00${index + 1}`),
              })
            )
          ),
          { concurrency: "unbounded" }
        );
        expect(burst.filter(Result.isSuccess)).toHaveLength(5);
        const rejected = burst.find(Result.isFailure);
        expect(rejected).toBeDefined();
        if (rejected === undefined || Result.isSuccess(rejected)) return;
        expect(Schema.is(ValidationFailed)(rejected.failure)).toBe(true);
        const rows = yield* sql`SELECT count(*)::int AS count FROM statement_submissions`;
        expect(rows).toEqual([{ count: 5 }]);
      })
    );

    it.effect("queues idempotently and consumes the lifetime Free grant only once", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        yield* seedConsentedPatIdentity({
          userId: freeUserId,
          bearer: freeBearer,
          tokenId: freeTokenId,
          scopes: ["read", "write"],
        });
        const sql = yield* MigrationSqlClient;
        yield* sql`
          UPDATE users SET paid_tier = 'free', trial_started_at = '2020-01-01T00:00:00Z',
            trial_ends_at = '2020-01-08T00:00:00Z'
          WHERE id = ${freeUserId}
        `;
        const client = yield* FreeApiClient;
        const payload = statementPayload("f1d1a000-0000-4000-8000-00000000c181");

        const first = yield* client.ingestion.submitForExtraction({ payload });
        const retry = yield* client.ingestion.submitForExtraction({ payload });
        expect(first.data.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        );
        expect(retry.data.id).toBe(first.data.id);

        const second = yield* Effect.result(
          client.ingestion.submitForExtraction({
            payload: statementPayload("f1d1a000-0000-4000-8000-00000000c182"),
          })
        );
        expect(Result.isFailure(second)).toBe(true);
        if (Result.isSuccess(second)) return;
        expect(Schema.is(PaywallRequired)(second.failure)).toBe(true);

        const oversized = yield* Effect.result(
          client.ingestion.submitForExtraction({
            payload: {
              ...statementPayload("f1d1a000-0000-4000-8000-00000000c185"),
              file: {
                name: "oversized.csv",
                declaredMediaType: "text/csv",
                contentBase64: Base64FileContent.make(
                  Encoding.encodeBase64(new Uint8Array(oversizedStatementBytes))
                ),
              },
            },
          })
        );
        expect(Result.isFailure(oversized)).toBe(true);
        const retained = yield* sql`
          SELECT
            (SELECT count(*)::int FROM statement_submissions WHERE user_id = ${freeUserId}) AS submissions,
            (SELECT content_hash FROM statement_submissions WHERE user_id = ${freeUserId})
              AS "contentHash",
            (SELECT submission_id FROM statement_backfill_entitlements
              WHERE user_id = ${freeUserId}) AS "grantSubmissionId"
        `;
        expect(retained).toEqual([
          {
            submissions: 1,
            contentHash: "d971c17831ee0061bf737859315496e13e734b93529fea78e23096df1215b9ca",
            grantSubmissionId: first.data.id,
          },
        ]);

        const visible = yield* client.ingestion.getStatementSubmission({
          params: { id: first.data.id },
        });
        expect(visible.data.status).toBe("queued");
      })
    );
  }
);
