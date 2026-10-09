import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UIReference } from "./reference";

const preference = Object.assign(new EventTarget(), { matches: false });
beforeEach(() => {
  preference.matches = false;
  vi.stubGlobal("matchMedia", () => preference);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps example content available while switching explicit and system appearance", () => {
  const { container } = render(<UIReference />);
  const preview = container.firstElementChild;
  expect(preview).toHaveClass("dark");
  expect(screen.getByRole("button", { name: "Oscuro" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Monto con error")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("Aún no hay transacciones este mes")).toBeInTheDocument();
  expect(screen.getByLabelText("Ejemplo de carga")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Claro" }));
  expect(preview).not.toHaveClass("dark");
  fireEvent.click(screen.getByRole("button", { name: "Sistema" }));
  expect(preview).not.toHaveClass("dark");
  act(() => {
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
  });
  expect(preview).toHaveClass("dark");
  expect(screen.getByLabelText("Monto en COP")).toHaveAccessibleDescription(
    "Ejemplo: 28000 para una transacción de $28.000 COP."
  );
});

it("previews each alternative palette and returns to the approved Grafito palette", () => {
  const { container } = render(<UIReference />);
  const preview = container.firstElementChild;
  for (const [name, id] of [
    ["Carbón cálido", "charcoal"],
    ["Oliva oscuro", "olive"],
    ["Espresso", "espresso"],
    ["Grafito", "graphite"],
  ]) {
    fireEvent.click(screen.getByRole("button", { name: "Claro" }));
    fireEvent.click(screen.getByRole("button", { name: `Probar ${name}` }));
    expect(preview).toHaveAttribute("data-dark-palette", id);
    expect(preview).toHaveClass("dark");
    expect(screen.getByRole("button", { name: `Probar ${name}` })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  }
  expect(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
  expect(screen.getAllByText("− $28.000 COP")).toHaveLength(4);
});
