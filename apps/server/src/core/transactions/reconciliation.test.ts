import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Option } from "effect";
import { Currency, Money } from "~/core/_shared/money";
import { TransactionId } from "./model";
import { type ReconciliationMember, decideTransactionLink } from "./reconciliation";

const member = (id: string): ReconciliationMember => ({
  id: TransactionId.make(id),
  money: Money.make({
    amount: BigDecimal.fromStringUnsafe("25000"),
    currency: Currency.make("COP"),
  }),
  direction: "outflow",
  createdAt: DateTime.makeUnsafe("2026-07-20T12:00:00Z"),
  correctedAt: Option.none(),
  hasStatementSource: false,
  categoryUserDecided: false,
  counterpartyUserDecided: false,
  notesUserDecided: false,
});

it.effect("selects the earliest-created identity and latest statement member", () =>
  Effect.gen(function* () {
    const notification = member("10000000-0000-4000-8000-000000000001");
    const statement = {
      ...member("20000000-0000-4000-8000-000000000002"),
      hasStatementSource: true,
      createdAt: DateTime.makeUnsafe("2026-07-20T13:00:00Z"),
      correctedAt: Option.some(DateTime.makeUnsafe("2026-07-20T14:00:00Z")),
    } satisfies ReconciliationMember;

    const decision = yield* decideTransactionLink(notification, statement);

    expect(decision.visibleTransactionId).toBe(notification.id);
    expect(decision.statementTransactionId).toEqual(Option.some(statement.id));
    expect(decision.authorities).toMatchObject({
      movementTransactionId: statement.id,
      categoryTransactionId: notification.id,
    });
  })
);

it.effect("uses the greater Transaction id to break equal statement timestamps", () =>
  Effect.gen(function* () {
    const first = {
      ...member("10000000-0000-4000-8000-000000000001"),
      hasStatementSource: true,
    } satisfies ReconciliationMember;
    const second = {
      ...member("20000000-0000-4000-8000-000000000002"),
      hasStatementSource: true,
    } satisfies ReconciliationMember;

    const decision = yield* decideTransactionLink(first, second);

    expect(decision.statementTransactionId).toEqual(Option.some(second.id));
  })
);

it.effect("rejects a different Currency before choosing authoritative members", () =>
  Effect.gen(function* () {
    const first = member("10000000-0000-4000-8000-000000000001");
    const second = {
      ...member("20000000-0000-4000-8000-000000000002"),
      money: Money.make({
        amount: BigDecimal.fromStringUnsafe("25000"),
        currency: Currency.make("USD"),
      }),
    } satisfies ReconciliationMember;

    const failure = yield* Effect.flip(decideTransactionLink(first, second));

    expect(failure).toMatchObject({
      _tag: "IneligibleTransactionPair",
      reason: "different-currency",
    });
  })
);
