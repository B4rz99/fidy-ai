import { expect, layer } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Equal, Schema } from "effect";
import { Currency, Money } from "~/core/_shared/money";
import { TransactionId } from "~/core/transactions/model";
import { type Affordance } from "~/shell/_shared/envelope";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { ApiHarness, ApiHarnessClient } from "~/shell/testing/api-harness";
import { publishedOperationIds } from "~/shell/testing/openapi";
import { transactionPayload, truncateTransactions } from "./fixtures";

const utcDateTime = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

/** Well-formed, so it passes the contract gate, and never logged by anyone. */
const absentId = TransactionId.make("f1d1a000-0000-4000-8000-00000000dead");

const isNotFound = Schema.is(NotFound);
const isValidationFailed = Schema.is(ValidationFailed);

const toolNames = (affordances: ReadonlyArray<Affordance>): ReadonlyArray<string> =>
  affordances.map((affordance) => affordance.tool);

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "transactions operations",
  (it) => {
    it.effect("logs a transaction and lists it back through the derived client", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const payload = transactionPayload();

        const created = yield* client.transactions.createTransaction({ payload });

        expect(created.data).toMatchObject(payload);

        const listed = yield* client.transactions.listTransactions();

        expect(listed.data).toEqual([created.data]);
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
        const listed = yield* client.transactions.listTransactions();

        expect(Equal.equals(created.data.money.amount, exactMoney.amount)).toBe(true);
        expect(read.data).toEqual(created.data);
        expect(listed.data).toEqual([created.data]);
      })
    );

    it.effect("listing an empty history returns the envelope with empty data and next", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const listed = yield* client.transactions.listTransactions();

        expect(listed).toEqual({ data: [], next: [] });
      })
    );

    it.effect("affordances only name canonical operation ids the generators expose", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const created = yield* client.transactions.createTransaction({
          payload: transactionPayload(),
        });
        const operationIds = yield* publishedOperationIds;

        expect(created.next.length).toBeGreaterThan(0);
        for (const affordance of created.next) {
          expect(operationIds).toContain(affordance.tool);
        }
      })
    );

    it.effect("refuses a movement dated after now, naming the field to correct", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        // A rule the contract cannot carry, because it needs the clock; the
        // caller is told about it in the same envelope, with the same code, as
        // one the contract gate caught.
        const failure = yield* Effect.flip(
          client.transactions.createTransaction({
            payload: transactionPayload({ occurredAt: utcDateTime("2099-01-01T00:00:00Z") }),
          })
        );

        expect(isValidationFailed(failure) ? failure.error.code : undefined).toBe(
          "validation_failed"
        );
        expect(
          isValidationFailed(failure) ? failure.error.fields.map((field) => field.path) : []
        ).toEqual(["occurredAt"]);

        const listed = yield* client.transactions.listTransactions();

        expect(listed.data).toEqual([]);
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

    it.effect("a failure carries affordances on the same terms as a success", () =>
      Effect.gen(function* () {
        yield* truncateTransactions;
        const client = yield* ApiHarnessClient;

        const failure = yield* Effect.flip(
          client.transactions.getTransaction({ params: { id: absentId } })
        );
        const operationIds = yield* publishedOperationIds;

        // The same check the success envelope gets, and hand-written for the
        // same single operation rather than swept from the contracts: an error
        // may only advertise operations the generators actually publish.
        const advertised = isNotFound(failure) ? toolNames(failure.next) : [];

        expect(advertised.length).toBeGreaterThan(0);
        for (const tool of advertised) {
          expect(operationIds).toContain(tool);
        }
      })
    );
  }
);
