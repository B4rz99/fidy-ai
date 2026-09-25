import { assert, expect, it } from "@effect/vitest";
import { BigDecimal, Cause, DateTime, Effect, Exit, Function } from "effect";
import { Currency, Money } from "~/core/_shared/money";
import { IneligibleTransactionPair, SameTransactionPair } from "./errors";
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
});

it.effect("selects the earliest-created identity as the visible member", () =>
  Effect.gen(function* () {
    const notification = member("10000000-0000-4000-8000-000000000001");
    const statement = {
      ...member("20000000-0000-4000-8000-000000000002"),
      createdAt: DateTime.makeUnsafe("2026-07-20T13:00:00Z"),
    } satisfies ReconciliationMember;

    const decision = yield* decideTransactionLink(notification, statement);

    expect(decision.visibleTransactionId).toBe(notification.id);
  })
);

it.effect("keeps the pair and visible identity invariant to caller order", () =>
  Effect.gen(function* () {
    const first = member("10000000-0000-4000-8000-000000000001");
    const second = member("20000000-0000-4000-8000-000000000002");

    const decision = yield* decideTransactionLink(first, second);
    const reversedDecision = yield* decideTransactionLink(second, first);

    expect(decision.visibleTransactionId).toBe(first.id);
    expect(reversedDecision.visibleTransactionId).toBe(first.id);
    expect(reversedDecision.pair).toEqual(decision.pair);
    expect(decision.pair).toEqual({
      firstTransactionId: first.id,
      secondTransactionId: second.id,
    });
  })
);

it.effect("rejects a different Currency before choosing the visible member", () =>
  Effect.gen(function* () {
    const first = member("10000000-0000-4000-8000-000000000001");
    const second = {
      ...member("20000000-0000-4000-8000-000000000002"),
      money: Money.make({
        amount: BigDecimal.fromStringUnsafe("25000"),
        currency: Currency.make("USD"),
      }),
    } satisfies ReconciliationMember;

    assert.deepStrictEqual(
      Exit.match(yield* Effect.exit(decideTransactionLink(first, second)), {
        onFailure: Function.flow(Cause.squash, Exit.fail),
        onSuccess: Exit.succeed,
      }),
      Exit.fail(new IneligibleTransactionPair({ reason: "different-currency" }))
    );
  })
);

it.effect("rejects a pair whose exact Money differs by one minor unit", () =>
  Effect.gen(function* () {
    const first = member("10000000-0000-4000-8000-000000000001");
    const second = {
      ...member("20000000-0000-4000-8000-000000000002"),
      money: Money.make({
        amount: BigDecimal.fromStringUnsafe("25000.01"),
        currency: Currency.make("COP"),
      }),
    } satisfies ReconciliationMember;

    assert.deepStrictEqual(
      Exit.match(yield* Effect.exit(decideTransactionLink(first, second)), {
        onFailure: Function.flow(Cause.squash, Exit.fail),
        onSuccess: Exit.succeed,
      }),
      Exit.fail(new IneligibleTransactionPair({ reason: "different-amount" }))
    );
  })
);

it.effect("links equal Money written with a different number of fractional digits", () =>
  Effect.gen(function* () {
    const first = member("10000000-0000-4000-8000-000000000001");
    const second = {
      ...member("20000000-0000-4000-8000-000000000002"),
      money: Money.make({
        amount: BigDecimal.fromStringUnsafe("25000.00"),
        currency: Currency.make("COP"),
      }),
    } satisfies ReconciliationMember;

    const decision = yield* decideTransactionLink(first, second);

    expect(decision.visibleTransactionId).toBe(first.id);
  })
);

it.effect("keeps a Reversal as its own movement and refuses to link it to what it undoes", () =>
  Effect.gen(function* () {
    const original = member("10000000-0000-4000-8000-000000000001");
    const reversal = {
      ...member("20000000-0000-4000-8000-000000000002"),
      direction: "inflow" as const,
    } satisfies ReconciliationMember;

    assert.deepStrictEqual(
      Exit.match(yield* Effect.exit(decideTransactionLink(original, reversal)), {
        onFailure: Function.flow(Cause.squash, Exit.fail),
        onSuccess: Exit.succeed,
      }),
      Exit.fail(new IneligibleTransactionPair({ reason: "incompatible-direction" }))
    );
  })
);

it.effect("rejects a pair that names the same Transaction twice", () =>
  Effect.gen(function* () {
    const only = member("10000000-0000-4000-8000-000000000001");

    assert.deepStrictEqual(
      Exit.match(yield* Effect.exit(decideTransactionLink(only, only)), {
        onFailure: Function.flow(Cause.squash, Exit.fail),
        onSuccess: Exit.succeed,
      }),
      Exit.fail(new SameTransactionPair({ transactionId: only.id }))
    );
  })
);
