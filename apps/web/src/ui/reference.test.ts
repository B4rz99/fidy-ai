import { fireEvent, screen } from "@testing-library/dom";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { mountUIReference } from "./reference";

const preference = Object.assign(new EventTarget(), { matches: false });
const nextPaint: Effect.Effect<void> = Effect.callback((resume) => {
  requestAnimationFrame(() => queueMicrotask(() => resume(Effect.void)));
});
beforeEach(() => {
  preference.matches = false;
  vi.stubGlobal("matchMedia", () => preference);
});
afterEach(() => {
  cleanupFoldkit();
  vi.unstubAllGlobals();
});
it("keeps example content available while switching explicit and system appearance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { container } = renderFoldkit(mountUIReference);
      yield* nextPaint;
      const preview = container.firstElementChild;
      expect(preview).toHaveClass("dark");
      expect(screen.getByRole("button", { name: "Oscuro" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      expect(screen.getByLabelText("Monto con error")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText("Aún no hay transacciones este mes")).toBeInTheDocument();
      expect(screen.getByLabelText("Ejemplo de carga")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Claro" }));
      yield* nextPaint;
      expect(preview).not.toHaveClass("dark");
      fireEvent.click(screen.getByRole("button", { name: "Sistema" }));
      yield* nextPaint;
      expect(preview).not.toHaveClass("dark");
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
      yield* nextPaint;
      expect(preview).toHaveClass("dark");
      expect(screen.getByLabelText("Monto en COP")).toHaveAccessibleDescription(
        "Ejemplo: 28000 para una transacción de $28.000 COP."
      );
    })
  ));
it("previews each alternative palette and returns to the approved Grafito palette", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { container } = renderFoldkit(mountUIReference);
      yield* nextPaint;
      const preview = container.firstElementChild;
      for (const [name, id] of [
        ["Carbón cálido", "charcoal"],
        ["Oliva oscuro", "olive"],
        ["Espresso", "espresso"],
        ["Grafito", "graphite"],
      ]) {
        fireEvent.click(screen.getByRole("button", { name: "Claro" }));
        yield* nextPaint;
        fireEvent.click(screen.getByRole("button", { name: `Probar ${name}` }));
        yield* nextPaint;
        expect(preview).toHaveAttribute("data-dark-palette", id);
        expect(preview).toHaveClass("dark");
        expect(screen.getByRole("button", { name: `Probar ${name}` })).toHaveAttribute(
          "aria-pressed",
          "true"
        );
      }
      expect(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
      expect(screen.getAllByText("− $28.000 COP")).toHaveLength(4);
    })
  ));
it("shares local category choices without changing the application or contacting a server", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      renderFoldkit(mountUIReference);
      yield* nextPaint;
      fireEvent.change(screen.getByLabelText("Categoría de ejemplo"), {
        target: { value: "groceries" },
      });
      yield* nextPaint;
      expect(screen.getByLabelText("Cambiar categoría del ejemplo")).toHaveValue("groceries");
      fireEvent.input(screen.getByLabelText("Buscar en el ejemplo"), { target: { value: "café" } });
      fireEvent.input(screen.getByLabelText("Fecha del ejemplo"), {
        target: { value: "2026-10-10" },
      });
      yield* nextPaint;
      expect(screen.getByLabelText("Buscar en el ejemplo")).toHaveValue("café");
      expect(screen.getByLabelText("Fecha del ejemplo")).toHaveValue("2026-10-10");
    })
  ));
