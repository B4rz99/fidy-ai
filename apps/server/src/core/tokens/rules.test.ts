import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { PATRecipientLabel } from "./model";
import { buildPATDisclosure, computePATExpiration } from "./rules";

it("includes the named recipient and every granted scope in Spanish disclosure", () => {
  const disclosure = buildPATDisclosure({
    recipientLabel: PATRecipientLabel.make("Mi agente financiero"),
    scopes: ["read", "write", "dashboard"],
  });

  expect(disclosure).toContain("Nombre: “Mi agente financiero”.");
  expect(disclosure).toContain("- Lectura: Consultar tus datos financieros en Fidy.");
  expect(disclosure).toContain("- Escritura: Crear y modificar tus datos financieros en Fidy.");
  expect(disclosure).toContain("- Tablero: Consultar y modificar tu tablero financiero en Fidy.");
});

it.effect("computes every fixed PAT lifetime from the issuance instant", () =>
  Effect.gen(function* () {
    const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
    const expirations = yield* Effect.all([
      computePATExpiration({ createdAt, lifetimeDays: 7 }),
      computePATExpiration({ createdAt, lifetimeDays: 30 }),
      computePATExpiration({ createdAt, lifetimeDays: 90 }),
      computePATExpiration({ createdAt, lifetimeDays: 365 }),
    ]);

    expect(expirations.map(DateTime.formatIso)).toEqual([
      "2026-01-08T00:00:00.000Z",
      "2026-01-31T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
  })
);
