import { expect, it } from "vitest";
import { currencyChoices } from "./currency-choices";

it("labels each currency with its code followed by its Spanish name", () => {
  expect(currencyChoices(["USD", "COP", "CAD"])).toEqual([
    { value: "USD", label: "USD · Dólar estadounidense" },
    { value: "COP", label: "COP · Peso colombiano" },
    { value: "CAD", label: "CAD · Dólar canadiense" },
  ]);
});
