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
  const phone = screen.getByText("Tu asistente · WhatsApp").closest(".phone");
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
  expect(screen.getByText("Tu asistente · WhatsApp").closest(".phone")).toBe(phone);
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

it("updates launch prices and links to first-party Google signup", () => {
  mountHome();
  expect(screen.getByText("$28.900", { selector: "[data-price-amount]" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Anual" }));
  expect(screen.getByText("$289.900", { selector: "[data-price-amount]" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Semanal" }));
  expect(screen.getByText("$9.900", { selector: "[data-price-amount]" })).toBeInTheDocument();
  expect(
    within(screen.getByRole("banner")).getByRole("link", { name: "Crear mi cuenta" })
  ).toHaveAttribute("href", "/auth/google");
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

it("preserves browser scroll timelines while cleaning up owned animations in Strict Mode", () => {
  class NativeScrollAnimation {
    cancel = vi.fn();
  }
  const scrollAnimation = new NativeScrollAnimation();
  const ownedAnimation = { cancel: vi.fn() };
  vi.stubGlobal("CSS", { supports: () => true });
  vi.stubGlobal("CSSAnimation", NativeScrollAnimation);
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element) {
      return this.classList.contains("fidy-landing")
        ? [scrollAnimation, ownedAnimation]
        : [ownedAnimation];
    },
  });
  const view = render(
    <StrictMode>
      <PublicHome />
    </StrictMode>
  );
  view.unmount();
  expect(ownedAnimation.cancel).toHaveBeenCalled();
  expect(scrollAnimation.cancel).not.toHaveBeenCalled();
});

it("restores a saved theme and tolerates unavailable browser storage", () => {
  localStorage.setItem("fidy-landing-theme", "dark");
  const view = render(<FeatureDetail index={0} />);
  expect(screen.getByRole("button", { name: "Activar tema claro" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Activar tema claro" }));
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
  expect(screen.getByRole("button", { name: "Activar tema oscuro" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Activar tema oscuro" }));
  expect(screen.getByRole("button", { name: "Activar tema claro" })).toBeInTheDocument();
});

it("explains the trial and exposes privacy, support and agent setup without changing signup", () => {
  render(<PublicHome />);
  expect(
    screen.getByText("7 días de Fidy Pro sin tarjeta. Tú eliges si te suscribes.")
  ).toBeVisible();
  const footer = screen.getByRole("navigation", { name: "Información y ayuda" });
  expect(within(footer).getByRole("link", { name: "Política de privacidad" })).toHaveAttribute(
    "href",
    "/politica"
  );
  expect(within(footer).getByRole("link", { name: "Cookies y almacenamiento" })).toHaveAttribute(
    "href",
    "/cookies"
  );
  expect(within(footer).getByRole("link", { name: "Contacto y soporte" })).toHaveAttribute(
    "href",
    "mailto:obarboza@fidyapp.com"
  );
  expect(within(footer).getByRole("link", { name: "Conecta tu agente" })).toHaveAttribute(
    "href",
    "/funciones/agentes#conectar"
  );
  for (const link of screen.getAllByRole("link", { name: /Crear mi cuenta/u })) {
    expect(link).toHaveAttribute("href", "/auth/google");
  }
});

it("offers least-privilege setup and keeps each revocation destination explicit", () => {
  render(<FeatureDetail index={5} />);
  const guide = screen.getByRole("region", { name: "Conecta con contexto." });
  expect(within(guide).getByText(/codex mcp login fidy --scopes read/u)).toBeVisible();
  expect(within(guide).queryByText(/todavía en preparación/u)).not.toBeInTheDocument();
  expect(within(guide).getByRole("link", { name: "Agentes conectados" })).toHaveAttribute(
    "href",
    "/settings/agents"
  );
  expect(
    within(guide).getByText(/No hay un paquete público de instalación documentado/u)
  ).toBeInTheDocument();
});

it("updates canonical and share metadata without retaining the previous public page description", () => {
  const home = render(<PublicHome />);
  expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://app.fidyapp.com/"
  );
  home.unmount();
  render(<FeatureDetail index={5} />);
  expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://app.fidyapp.com/funciones/agentes"
  );
  expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute(
    "content",
    "https://app.fidyapp.com/funciones/agentes"
  );
});

it("keeps legal review status separate from an active service agreement", () => {
  render(<PublicHome />);
  expect(screen.getByRole("link", { name: "Términos de servicio (borrador)" })).toHaveAttribute(
    "href",
    "/terminos"
  );
});

it("uses concise first-use wording and the ChatGPT brand", () => {
  render(<PublicHome />);
  expect(screen.getByRole("heading", { name: "Conéctalo a ChatGPT o Claude" })).toBeVisible();
  expect(screen.getByText(/adjuntar un Excel por WhatsApp/u)).toBeVisible();
  expect(screen.queryByText(/Nunca envíes claves/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/Fidy refleja la información/u)).not.toBeInTheDocument();
  expect(screen.queryByText(/CSV o XLSX/u)).not.toBeInTheDocument();
});
