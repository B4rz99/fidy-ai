import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicHome } from "@/features/public-site/home";
import { FeatureDetail } from "./feature-detail";

// JSDOM has no layout/WAAPI. These browser-boundary fixtures deliver visible intersections
// while the assertions exercise the public UI and its React-owned state.
const preference = Object.assign(new EventTarget(), { matches: false });
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }));
beforeEach(() => {
  localStorage.clear();
  preference.matches = false;
  vi.stubGlobal("matchMedia", () => preference);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (
        entries: ReadonlyArray<Pick<IntersectionObserverEntry, "target" | "isIntersecting">>
      ) => void;
      constructor(
        callback: (
          entries: ReadonlyArray<Pick<IntersectionObserverEntry, "target" | "isIntersecting">>
        ) => void
      ) {
        this.callback = callback;
      }
      observe(target: Element): void {
        this.callback([{ target, isIntersecting: true }]);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ cancel }],
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement): void {
      this.open = true;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mountHome = (): void => {
  render(
    <StrictMode>
      <PublicHome />
    </StrictMode>
  );
};

it("switches and replays local conversations while retaining the phone shell", () => {
  mountHome();
  const phone = screen.getByText("Tu asistente · Web app").closest(".phone");
  fireEvent.click(screen.getByRole("button", { name: "Consultar" }));
  expect(
    screen.getByText("Tienes 12 transacciones en Restaurantes. La más reciente: $28.000 en Crepes.")
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Presupuestar" }));
  expect(screen.getByText("Tu presupuesto está listo.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Repetir animación de la conversación" }), {
    detail: 1,
  });
  fireEvent.click(screen.getByRole("button", { name: "Presupuestar" }));
  expect(screen.getByText("Tu asistente · Web app").closest(".phone")).toBe(phone);
  fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
  expect(screen.getByRole("button", { name: "Registrar" })).toHaveAttribute("aria-pressed", "true");
});

it("supports keyboard feature selection and links each preview to its detailed view", () => {
  mountHome();
  const first = screen.getByRole("tab", { name: "Transacciones" });
  fireEvent.keyDown(first, { key: "ArrowLeft" });
  expect(screen.getByRole("tab", { name: "Tus agentes" })).toHaveFocus();
  expect(screen.getByRole("link", { name: "Explorar tus agentes ↗" })).toHaveAttribute(
    "href",
    "/funciones/agentes"
  );
  fireEvent.keyDown(screen.getByRole("tab", { name: "Tus agentes" }), { key: "Home" });
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Presupuestos" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  fireEvent.keyDown(screen.getByRole("tab", { name: "Presupuestos" }), { key: "End" });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Tus agentes" }), { key: "Tab" });
  fireEvent.click(first, { detail: 1 });
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Transacciones");
  preference.matches = true;
  fireEvent.click(screen.getByRole("tab", { name: "Hallazgos" }), { detail: 1 });
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Hallazgos");
  preference.dispatchEvent(new Event("change"));
});

it("updates launch prices and keeps signup as a dismissible placeholder", () => {
  mountHome();
  expect(screen.getByText("Cobro de $28.900 COP cada mes.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Anual" }));
  expect(screen.getByText("Cobro de $289.900 COP cada año.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Semanal" }));
  expect(screen.getByText("Cobro de $9.900 COP cada semana.")).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("banner")).getByRole("button", { name: "Empezar con Fidy" })
  );
  const dialog = screen.getByRole("dialog", { name: "Registro de Fidy" });
  expect(within(dialog).getByText(/Por ahora es un placeholder/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Seguir explorando ↗" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(
    within(screen.getByRole("banner")).getByRole("button", { name: "Empezar con Fidy" })
  );
  fireEvent(screen.getByRole("dialog"), new Event("close"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("closes compact navigation on selection, focus departure and Escape", () => {
  mountHome();
  fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
  const toggle = screen.getByRole("button", { name: "Cerrar menú" });
  fireEvent.keyDown(toggle, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Abrir menú" })).toHaveFocus();
  fireEvent.click(toggle);
  fireEvent.blur(toggle, {
    relatedTarget: screen.getByRole("link", { name: "Funciones" }),
  });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(screen.getByRole("link", { name: "Funciones" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.keyDown(toggle, { key: "Tab" });
  fireEvent.click(toggle);
  fireEvent.blur(toggle, { relatedTarget: document.body });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("registers and resets only the illustrative dashboard transaction", () => {
  mountHome();
  fireEvent.click(screen.getByRole("button", { name: "Registrar ejemplo" }));
  expect(screen.getByText("$1.084.000")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Una transacción de $28.000 registrada en Restaurantes."
  );
  fireEvent.click(screen.getByRole("button", { name: /Reiniciar ejemplo/ }), { detail: 1 });
  expect(screen.getByText("$1.056.000")).toBeInTheDocument();
});

it("corrects the same illustrative transaction in its detail view and resets it", () => {
  render(<FeatureDetail index={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Probar una corrección" }));
  expect(screen.getByText("$26.000 COP")).toBeInTheDocument();
  expect(screen.getByText("− $26.000")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Es la misma transacción.");
  fireEvent.click(screen.getByRole("button", { name: /Reiniciar ejemplo/ }));
  expect(screen.getByText("$28.000 COP")).toBeInTheDocument();
});

it("honors reduced motion and cancels owned animations on unmount", () => {
  preference.matches = true;
  const view = render(
    <StrictMode>
      <PublicHome />
    </StrictMode>
  );
  expect(animate).toHaveBeenCalledWith(
    [{ opacity: 0 }, { opacity: 1 }],
    expect.objectContaining({ delay: 0, duration: 160 })
  );
  cancel.mockClear();
  view.unmount();
  expect(cancel).toHaveBeenCalled();
});

it("restores a saved theme and tolerates unavailable browser storage", () => {
  localStorage.setItem("fidy-landing-theme", "dark");
  const view = render(<FeatureDetail index={0} />);
  expect(screen.getByRole("button", { name: "Oscuro", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(screen.getByRole("button", { name: "Claro", exact: true }));
  expect(localStorage.getItem("fidy-landing-theme")).toBe("light");
  view.unmount();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Storage unavailable");
    },
    setItem: () => {
      throw new Error("Storage unavailable");
    },
  });
  render(<FeatureDetail index={0} />);
  expect(screen.getByRole("button", { name: "Sistema", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(screen.getByRole("button", { name: "Oscuro", exact: true }));
  expect(screen.getByRole("button", { name: "Oscuro", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});
