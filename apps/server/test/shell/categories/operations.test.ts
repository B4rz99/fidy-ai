import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { listCategoriesResponse } from "~/shell/categories/operations";

it.effect("supplies the ordered launch Category response without a storage dependency", () =>
  Effect.gen(function* () {
    const response = yield* listCategoriesResponse;
    expect(response.data.map(({ label }) => label)).toEqual([
      "Restaurantes",
      "Domicilios",
      "Mercado",
      "Transporte",
      "Vivienda",
      "Servicios",
      "Salud",
      "Educación",
      "Compras",
      "Entretenimiento",
      "Viajes",
      "Impuestos",
      "Transferencias",
      "Retiros de efectivo",
      "Ingresos",
      "Otros",
    ]);
    expect(response.data[0]?.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(response.next).toEqual([]);
  })
);
