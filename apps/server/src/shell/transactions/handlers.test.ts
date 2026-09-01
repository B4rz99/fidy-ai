import { expect, layer } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Layer, Option, Result, Schema } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";
import { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money } from "~/core/_shared/money";
import { categoryIds } from "~/core/categories/taxonomy";
import { TransactionId } from "~/core/transactions/model";
import { type SuggestedOperation } from "~/shell/_shared/response";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { defaultUserId } from "~/shell/db/development-seed";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { getTransactionUserDecisions, transactionPayload, truncateTransactions } from "./fixtures";
import { correctTransaction, createTransaction, deleteTransaction } from "./mutations";

const TransactionHarness = Layer.merge(ApiHarness, TelemetryDisabled);

const utcDateTime = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

/** Well-formed, so it passes the validation gate, and never logged by anyone. */
const absentId = TransactionId.make("f1d1a000-0000-4000-8000-00000000dead");

const isNotFound = Schema.is(NotFound);
const isValidationFailed = Schema.is(ValidationFailed);

const toolNames = (suggestedOperations: ReadonlyArray<SuggestedOperation>): ReadonlyArray<string> =>
  suggestedOperations.map((suggestedOperation) => suggestedOperation.tool);

layer(TransactionHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "transactions operations",
  (it) => {
    it.effect("logs a transaction and lists it back through the derived client", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const payload = transactionPayload();

        const created = yield* client.transactions.createTransaction({ payload });

        expect(created.data).toMatchObject({
          ...payload,
          categoryId: categoryIds.restaurantes,
        });

        const listed = yield* client.transactions.listTransactions({ query: {} });

        expect(listed.data).toEqual([created.data]);
      })
    );

    it.effect("records exactly which caller capture facts the User decided", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const explicit = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: Option.some("Mercado Central"),
            categoryId: Option.some(categoryIds.mercado),
            notes: Option.some("Almuerzo del domingo"),
          }),
        });
        const automatic = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: Option.none(),
            categoryId: Option.none(),
            notes: Option.none(),
          }),
        });

        expect(yield* getTransactionUserDecisions(explicit.data.id)).toEqual({
          category: true,
          counterparty: true,
          notes: true,
        });
        expect(yield* getTransactionUserDecisions(automatic.data.id)).toEqual({
          category: false,
          counterparty: false,
          notes: false,
        });
      })
    );

    it.effect("stores a Transaction when capture identifies no Counterparty", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: Option.none(),
            categoryId: Option.none(),
          }),
        });
        const read = yield* client.transactions.getTransaction({
          params: { id: created.data.id },
        });

        expect(Option.isNone(created.data.counterparty)).toBe(true);
        expect(Option.isNone(read.data.counterparty)).toBe(true);
        expect(created.data.categoryId).toBe(categoryIds.otros);
      })
    );

    it.effect("assigns the fallback before storing an immutable manual attestation", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: "RÁPPI Turbo",
            categoryId: Option.none(),
          }),
        });
        const attestations = yield* client.transactions.listSourceAttestations({
          params: { id: created.data.id },
        });
        const sql = yield* MigrationSqlClient;
        const updateAttempt = yield* Effect.result(
          sql`UPDATE source_attestations SET interpretation_revision = 'tampered' WHERE transaction_id = ${created.data.id}`
        );
        const deleteAttempt = yield* Effect.result(
          sql`DELETE FROM source_attestations WHERE transaction_id = ${created.data.id}`
        );
        const retained = yield* client.transactions.listSourceAttestations({
          params: { id: created.data.id },
        });

        expect(Result.isFailure(updateAttempt)).toBe(true);
        expect(Result.isFailure(deleteAttempt)).toBe(true);
        expect(retained.data).toEqual(attestations.data);
        expect(created.data.categoryId).toBe(categoryIds.otros);
        expect(attestations.data).toHaveLength(1);
        expect(attestations.data[0]).toMatchObject({
          transactionId: created.data.id,
          kind: "manual",
          serviceMarket: "CO",
          locale: "es-CO",
          timeZone: "America/Bogota",
          interpretationRevision: "manual-v1",
        });
      })
    );

    it.effect(
      "uses the explicit fallback without inferring a Category from counterparty text",
      () =>
        Effect.gen(function* () {
          yield* truncateTransactions;
          const client = yield* ApiHarnessClient;

          const transfer = yield* client.transactions.createTransaction({
            payload: transactionPayload({
              counterparty: "Transferencia a Juan",
              categoryId: Option.none(),
            }),
          });
          const walletPurchase = yield* client.transactions.createTransaction({
            payload: transactionPayload({
              counterparty: "Nequi El Corral",
              categoryId: Option.none(),
            }),
          });

          expect(transfer.data.categoryId).toBe(categoryIds.otros);
          expect(walletPurchase.data.categoryId).toBe(categoryIds.otros);
        })
    );

    it.effect("rolls capture back when its SourceAttestation cannot be inserted", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          CREATE OR REPLACE FUNCTION reject_manual_attestation() RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'injected attestation failure';
          END;
          $$ LANGUAGE plpgsql
        `;
        yield* sql`DROP TRIGGER IF EXISTS reject_manual_attestation ON source_attestations`;
        yield* sql`
          CREATE TRIGGER reject_manual_attestation BEFORE INSERT ON source_attestations
          FOR EACH ROW EXECUTE FUNCTION reject_manual_attestation()
        `;
        const removeFailure = sql`
          DROP TRIGGER IF EXISTS reject_manual_attestation ON source_attestations
        `.pipe(
          Effect.andThen(sql`DROP FUNCTION IF EXISTS reject_manual_attestation()`),
          Effect.orDie
        );

        yield* Effect.gen(function* () {
          yield* Effect.flip(
            client.transactions.createTransaction({ payload: transactionPayload() })
          );
          const history = yield* client.transactions.listTransactions({ query: {} });
          expect(history.data).toEqual([]);
        }).pipe(Effect.ensuring(removeFailure));
      })
    );

    it.effect("continues capture beyond a large retained Transaction history", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const sql = yield* MigrationSqlClient;
        yield* sql`
          INSERT INTO transactions
            (user_id, amount, currency, counterparty, direction, category_id, occurred_at)
          SELECT ${defaultUserId}, 1, 'COP', 'History seed', 'outflow',
            ${categoryIds.otros}, '2026-01-01T00:00:00Z'
          FROM generate_series(1, 100000)
        `;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "After large history" }),
        });

        expect(created.data.counterparty).toEqual(Option.some("After large history"));
      })
    );

    it.effect("creating a transaction suggests listing transactions as the next call", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });

        expect(toolNames(created.next)).toContain("transactions.listTransactions");
      })
    );

    it.effect("preserves exact fractional Money through create, get, and list", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const exactMoney = Money.make({
          amount: BigDecimal.fromStringUnsafe("450000000000.75"),
          currency: Currency.make("USD"),
        });

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload({ money: exactMoney }),
        });
        const read = yield* client.transactions.getTransaction({
          params: { id: created.data.id },
        });
        const listed = yield* client.transactions.listTransactions({ query: {} });

        expect(Equal.equals(created.data.money.amount, exactMoney.amount)).toBe(true);
        expect(read.data).toEqual(created.data);
        expect(listed.data).toEqual([created.data]);
      })
    );

    it.effect("listing an empty history returns the response with empty data and next", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const listed = yield* client.transactions.listTransactions({ query: {} });

        expect(listed).toEqual({ data: [], next: [] });
      })
    );

    it.effect("refuses a movement dated after now, naming the field to correct", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        // A rule the input schema cannot carry, because it needs the clock; the
        // caller is told about it in the same response, with the same code, as
        // one the validation gate caught.
        const rejectedOccurredAt = utcDateTime("2099-01-01T00:00:00Z");
        const failure = yield* Effect.flip(
          client.transactions.createTransaction({
            payload: transactionPayload({ occurredAt: rejectedOccurredAt }),
          })
        );

        expect(isValidationFailed(failure) ? failure.error.code : undefined).toBe(
          "validation_failed"
        );
        expect(
          isValidationFailed(failure) ? failure.error.fields.map((field) => field.path) : []
        ).toEqual(["occurredAt"]);
        expect(
          isValidationFailed(failure)
            ? failure.error.fields.map((field) => field.message).join("\n")
            : ""
        ).not.toContain(DateTime.formatIso(rejectedOccurredAt));

        const listed = yield* client.transactions.listTransactions({ query: {} });

        expect(listed.data).toEqual([]);
      })
    );

    it.effect("rejects a period whose start is not before its end", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const failure = yield* Effect.flip(
          client.transactions.listTransactions({
            query: {
              from: utcDateTime("2026-08-01T00:00:00Z"),
              to: utcDateTime("2026-07-01T00:00:00Z"),
            },
          })
        );

        expect(isValidationFailed(failure)).toBe(true);
        expect(isValidationFailed(failure) ? failure.error.fields[0]?.path : undefined).toBe(
          "from"
        );
      })
    );

    it.effect("combines period, Category, counterparty, direction, and Currency filters", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const wanted = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: "RÁPPI Turbo",
            categoryId: Option.some(categoryIds.domicilios),
            occurredAt: utcDateTime("2026-07-20T12:30:00Z"),
          }),
        });
        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: "Nómina",
            direction: "inflow",
            categoryId: Option.some(categoryIds.ingresos),
            occurredAt: utcDateTime("2026-07-10T12:30:00Z"),
          }),
        });
        yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: "Rappi",
            money: Money.make({ amount: BigDecimal.fromStringUnsafe("10"), currency: "USD" }),
            categoryId: Option.some(categoryIds.domicilios),
            occurredAt: utcDateTime("2026-07-21T12:30:00Z"),
          }),
        });

        const listed = yield* client.transactions.listTransactions({
          query: {
            from: utcDateTime("2026-07-15T00:00:00Z"),
            to: utcDateTime("2026-08-01T00:00:00Z"),
            categoryId: categoryIds.domicilios,
            counterparty: "rappi",
            direction: "outflow",
            currency: "COP",
          },
        });

        expect(listed.data).toEqual([wanted.data]);
      })
    );

    it.effect("uses Transaction identity to stabilize newest-first ties", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const sql = yield* MigrationSqlClient;
        const occurredAt = utcDateTime("2026-07-20T12:30:00Z");
        const first = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "Primera", occurredAt }),
        });
        const second = yield* client.transactions.createTransaction({
          payload: transactionPayload({ counterparty: "Segunda", occurredAt }),
        });
        yield* sql`
          UPDATE transactions SET created_at = '2026-07-21T00:00:00Z'
          WHERE id IN (${first.data.id}, ${second.data.id})
        `;

        const listed = yield* client.transactions.listTransactions({ query: {} });
        const expectedIds = [first.data.id, second.data.id].toSorted((left, right) =>
          right.localeCompare(left)
        );
        expect(listed.data.map((transaction) => transaction.id)).toEqual(expectedIds);
      })
    );

    it.effect("retains capture context after the User changes preferences", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });
        const restore = client.identity
          .updateUserPreferences({
            payload: { locale: "es-CO", timeZone: IanaTimeZone.make("America/Bogota") },
          })
          .pipe(Effect.orDie);

        yield* Effect.gen(function* () {
          yield* client.identity.updateUserPreferences({
            payload: { locale: "es-CO", timeZone: IanaTimeZone.make("America/Lima") },
          });
          const attestations = yield* client.transactions.listSourceAttestations({
            params: { id: created.data.id },
          });
          expect(attestations.data[0]?.timeZone).toBe("America/Bogota");
        }).pipe(Effect.ensuring(restore));
      })
    );

    it.effect("rolls Transaction creation back with its caller-owned transaction", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const caller = freePatCaller(["write"]);

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            createTransaction({
              userId: defaultUserId,
              caller,
              payload: transactionPayload(),
            }).pipe(Effect.andThen(Effect.fail("rollback requested")))
          )
        );
        const retained = yield* client.transactions.listTransactions({ query: {} });

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(retained.data).toEqual([]);
      })
    );

    it.effect("rolls Transaction correction and deletion back together", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const caller = freePatCaller(["write"]);
        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });

        const rollback = yield* Effect.result(
          withUserTransaction(
            defaultUserId,
            Effect.gen(function* () {
              yield* correctTransaction({
                userId: defaultUserId,
                caller,
                transactionId: created.data.id,
                payload: {
                  money: created.data.money,
                  counterparty: Option.some("Corrección sin confirmar"),
                  direction: created.data.direction,
                  categoryId: created.data.categoryId,
                  notes: created.data.notes,
                  occurredAt: created.data.occurredAt,
                },
              });
              yield* deleteTransaction({
                userId: defaultUserId,
                caller,
                transactionId: created.data.id,
              });
              return yield* Effect.fail("rollback requested");
            })
          )
        );
        const retained = yield* client.transactions.getTransaction({
          params: { id: created.data.id },
        });

        expect(rollback).toEqual(Result.fail("rollback requested"));
        expect(retained.data).toEqual(created.data);
      })
    );

    it.effect("corrects a transaction, preserves provenance, and deletes it without restore", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;
        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload({
            counterparty: Option.some("Cafetería Central"),
            categoryId: Option.some(categoryIds.restaurantes),
            notes: Option.none(),
          }),
        });
        const before = yield* client.transactions.listSourceAttestations({
          params: { id: created.data.id },
        });
        const keywordRulesBefore = yield* client.categories.listKeywordRules({});
        expect(yield* getTransactionUserDecisions(created.data.id)).toEqual({
          category: true,
          counterparty: true,
          notes: false,
        });

        const updated = yield* client.transactions.updateTransaction({
          params: { id: created.data.id },
          payload: {
            money: created.data.money,
            counterparty: Option.some("El Corral corregido"),
            direction: created.data.direction,
            categoryId: categoryIds.otros,
            notes: Option.some("Corrección del usuario"),
            occurredAt: created.data.occurredAt,
          },
        });
        const after = yield* client.transactions.listSourceAttestations({
          params: { id: created.data.id },
        });

        expect(updated.data).toMatchObject({
          id: created.data.id,
          counterparty: Option.some("El Corral corregido"),
          categoryId: categoryIds.otros,
          notes: Option.some("Corrección del usuario"),
        });
        expect(after.data).toEqual(before.data);
        expect(yield* client.categories.listKeywordRules({})).toEqual(keywordRulesBefore);
        expect(yield* getTransactionUserDecisions(created.data.id)).toEqual({
          category: true,
          counterparty: true,
          notes: true,
        });

        const cleared = yield* client.transactions.updateTransaction({
          params: { id: created.data.id },
          payload: {
            money: updated.data.money,
            counterparty: Option.none(),
            direction: updated.data.direction,
            categoryId: updated.data.categoryId,
            notes: updated.data.notes,
            occurredAt: updated.data.occurredAt,
          },
        });
        expect(Option.isNone(cleared.data.counterparty)).toBe(true);
        expect(yield* getTransactionUserDecisions(created.data.id)).toEqual({
          category: true,
          counterparty: true,
          notes: true,
        });

        expect(
          (yield* client.transactions.deleteTransaction({ params: { id: created.data.id } })).data
        ).toBe(created.data.id);
        expect((yield* client.transactions.listTransactions({ query: {} })).data).toEqual([]);
        const retained = yield* client.transactions.listSourceAttestations({
          params: { id: created.data.id },
        });
        const deletedAgain = yield* Effect.flip(
          client.transactions.deleteTransaction({ params: { id: created.data.id } })
        );
        expect(retained.data).toEqual(before.data);
        expect(isNotFound(deletedAgain)).toBe(true);
      })
    );

    it.effect("reads one logged transaction back by its id", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });
        const read = yield* client.transactions.getTransaction({
          params: { id: created.data.id },
        });

        expect(read).toEqual({ data: created.data, next: [] });
      })
    );

    it.effect("asking for a transaction nobody logged answers not_found, not a 500", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const failure = yield* Effect.flip(
          client.transactions.getTransaction({ params: { id: absentId } })
        );

        expect(isNotFound(failure)).toBe(true);
        expect(isNotFound(failure) ? failure.error.code : undefined).toBe("not_found");
        expect(isNotFound(failure) ? failure.error.message : "").toContain(absentId);
      })
    );

    it.effect("not_found suggests listing transactions to recover the intended id", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const failure = yield* Effect.flip(
          client.transactions.getTransaction({ params: { id: absentId } })
        );
        const advertised = isNotFound(failure) ? toolNames(failure.next) : [];

        expect(advertised).toContain("transactions.listTransactions");
      })
    );
  }
);
