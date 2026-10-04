import { expect, it } from "vitest";
import { BigDecimal, Option, Schema } from "effect";
import { Money } from "~/core/_shared/money";
import { RefundIntent } from "./contract";
import { refundMinorUnits } from "./operations";

it("preserves exact COP minor units and refuses unsafe or fractional provider integers", () => {
  expect(refundMinorUnits(Schema.decodeSync(Money)({ amount: "0.29", currency: "COP" }))).toEqual(
    Option.some(29)
  );
  expect(refundMinorUnits({ amount: BigDecimal.make(1001n, 3), currency: "COP" })).toEqual(
    Option.none()
  );
  expect(
    refundMinorUnits(Schema.decodeSync(Money)({ amount: "90071992547409.92", currency: "COP" }))
  ).toEqual(Option.none());
});
it("refuses zero and excessive precision without inventing partial card voids", () => {
  expect(
    Schema.decodeOption(RefundIntent)({
      kind: "refund",
      money: { amount: "0", currency: "COP" },
    })
  ).toEqual(Option.none());
  expect(
    Schema.decodeOption(RefundIntent)({
      kind: "refund",
      money: { amount: "1.001", currency: "COP" },
    })
  ).toEqual(Option.none());
});
