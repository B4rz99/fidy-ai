import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TransactionListView } from "./feature";
import type { TransactionListRow } from "./presentation";

const period: Readonly<{ monthLabel: string; timeZone: string }> = {
  monthLabel: "julio de 2026",
  timeZone: "America/Bogota",
};
const row: TransactionListRow = {
  id: "24000000-0000-4000-8000-000000000002",
  categoryLabel: "Restaurantes",
  counterpartyLabel: "El Corral",
  direction: "outflow",
  directionLabel: "Salida",
  moneyText: "COP 25.000,00",
  occurredOnText: "20 de jul. de 2026",
};

describe("current-month Transaction list", () => {
  afterEach(cleanup);

  it("renders an accessible loading state", () => {
    render(<TransactionListView state={{ _tag: "Loading" }} />);

    expect(screen.getByLabelText("Cargando transacciones")).toBeVisible();
  });

  it("renders month and zone context with desktop and mobile Transaction rows", () => {
    render(<TransactionListView state={{ _tag: "Ready", period, rows: [row] }} />);

    expect(screen.getByText("julio de 2026")).toBeVisible();
    expect(screen.getByText("America/Bogota")).toBeVisible();

    const desktop = within(screen.getByLabelText("Tabla de transacciones"));
    expect(desktop.getByText("El Corral")).toBeVisible();
    expect(desktop.getByText("Restaurantes")).toBeVisible();
    expect(desktop.getByText("Salida")).toBeVisible();
    expect(desktop.getByText("COP 25.000,00")).toBeVisible();
    expect(desktop.getByText("20 de jul. de 2026")).toBeVisible();

    const mobile = within(screen.getByLabelText("Lista móvil de transacciones"));
    expect(mobile.getByText("El Corral")).toBeVisible();
    expect(mobile.getByText("Salida")).toBeVisible();
  });

  it("renders the current-month empty state with its applied zone", () => {
    render(<TransactionListView state={{ _tag: "Empty", period }} />);

    expect(screen.getByText("Aún no hay transacciones este mes")).toBeVisible();
    expect(screen.getByText("America/Bogota")).toBeVisible();
  });

  it("renders a canonical error without exposing its cause", () => {
    render(<TransactionListView state={{ _tag: "CanonicalError" }} />);

    expect(screen.getByText("No pudimos cargar tus transacciones")).toBeVisible();
    expect(screen.getByText("Intenta de nuevo en unos momentos.")).toBeVisible();
  });
});
