import { Effect } from "effect";
import { cleanupFoldkit, renderFoldkit } from "@/testing/foldkit";
import { mountPublicSite } from "@/features/public-site/native/program";
import { fireEvent, screen, within } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountConversation, mountPreview } from "./demo-motion";
import { mountIndicator, moveIndicator } from "./tab-indicator";

// JSDOM has no layout/WAAPI. These browser-boundary fixtures deliver visible intersections
// while the assertions exercise the public UI and its Foldkit-owned state.
const preference = Object.assign(new EventTarget(), {
  matches: false,
});
const cancel = vi.fn();
const animate = vi.fn(() => ({
  cancel,
}));
const intersections = new Map<Element, (visible: boolean) => void>();
beforeEach(() => {
  intersections.clear();
  localStorage.clear();
  preference.matches = false;
  vi.stubGlobal("matchMedia", () => preference);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (
        entries: ReadonlyArray<
          Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">
        >
      ) => void;
      constructor(
        callback: (
          entries: ReadonlyArray<
            Pick<IntersectionObserverEntry, "target" | "isIntersecting" | "intersectionRatio">
          >
        ) => void
      ) {
        this.callback = callback;
      }
      observe(target: Element): void {
        intersections.set(target, (isIntersecting) =>
          this.callback([
            {
              target,
              isIntersecting,
              intersectionRatio: isIntersecting ? 1 : 0,
            },
          ])
        );
        this.callback([
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
          },
        ]);
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
    value: () => [
      {
        cancel,
      },
    ],
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
  cleanupFoldkit();
  vi.unstubAllGlobals();
});
const mountHome = (): ReturnType<typeof renderFoldkit> => mountNative("/");
it("switches and replays local conversations while retaining the phone shell", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const phone = screen.getByText("Tu asistente · WhatsApp").closest(".phone");
      fireEvent.click(
        screen.getByRole("button", {
          name: "Consultar",
        })
      );
      yield* nextPaint;
      expect(
        screen.getByText(
          "Tienes 12 transacciones en Restaurantes. La más reciente: $28.000 en Crepes."
        )
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Presupuestar",
        })
      );
      yield* nextPaint;
      expect(screen.getByText("Tu presupuesto está listo.")).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Repetir animación de la conversación",
        }),
        {
          detail: 1,
        }
      );
      yield* nextPaint;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Presupuestar",
        })
      );
      yield* nextPaint;
      expect(screen.getByText("Tu asistente · WhatsApp").closest(".phone")).toBe(phone);
      fireEvent.click(
        screen.getByRole("button", {
          name: "Registrar",
        })
      );
      yield* nextPaint;
      expect(
        screen.getByRole("button", {
          name: "Registrar",
        })
      ).toHaveAttribute("aria-pressed", "true");
    })
  ));
it("supports keyboard feature selection and links each preview to its detailed view", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const first = screen.getByRole("tab", {
        name: "Transacciones",
      });
      fireEvent.keyDown(first, {
        key: "ArrowLeft",
      });
      yield* nextPaint;
      expect(
        screen.getByRole("tab", {
          name: "Tus agentes",
        })
      ).toHaveFocus();
      expect(
        screen.getByRole("link", {
          name: "Explorar tus agentes ↗",
        })
      ).toHaveAttribute("href", "/funciones/agentes");
      fireEvent.keyDown(
        screen.getByRole("tab", {
          name: "Tus agentes",
        }),
        {
          key: "Home",
        }
      );
      yield* nextPaint;
      fireEvent.keyDown(first, {
        key: "ArrowRight",
      });
      yield* nextPaint;
      expect(
        screen.getByRole("tab", {
          name: "Presupuestos",
        })
      ).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(
        screen.getByRole("tab", {
          name: "Presupuestos",
        }),
        {
          key: "End",
        }
      );
      yield* nextPaint;
      fireEvent.keyDown(
        screen.getByRole("tab", {
          name: "Tus agentes",
        }),
        {
          key: "Tab",
        }
      );
      yield* nextPaint;
      fireEvent.click(first, {
        detail: 1,
      });
      yield* nextPaint;
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Transacciones");
      preference.matches = true;
      fireEvent.click(
        screen.getByRole("tab", {
          name: "Hallazgos",
        }),
        {
          detail: 1,
        }
      );
      yield* nextPaint;
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Hallazgos");
      preference.dispatchEvent(new Event("change"));
    })
  ));
it("keeps keyboard-selected conversations and feature previews immediate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      animate.mockClear();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Consultar",
        }),
        {
          detail: 0,
        }
      );
      yield* nextPaint;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Repetir animación de la conversación",
        }),
        {
          detail: 0,
        }
      );
      yield* nextPaint;
      fireEvent.keyDown(
        screen.getByRole("tab", {
          name: "Transacciones",
        }),
        {
          key: "ArrowRight",
        }
      );
      yield* nextPaint;
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Presupuestos");
      expect(screen.getByText("De lo que has registrado en octubre:")).toBeVisible();
      expect(animate).not.toHaveBeenCalled();
    })
  ));
it("settles a departing conversation without replaying it when it returns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const shell = screen.getByText("Tu asistente · WhatsApp").closest(".demo-shell");
      expect(shell).not.toBeNull();
      if (shell === null) throw new Error("Missing conversation shell");
      cancel.mockClear();
      intersections.get(shell)?.(false);
      expect(cancel).toHaveBeenCalled();
      animate.mockClear();
      intersections.get(shell)?.(true);
      expect(animate).not.toHaveBeenCalled();
      expect(screen.getByText("Tu asistente · WhatsApp")).toBeVisible();
    })
  ));
it("updates launch prices and links to first-party Google signup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      expect(
        screen.getByText("$28.900", {
          selector: "[data-price-amount]",
        })
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Anual",
        })
      );
      yield* nextPaint;
      expect(
        screen
          .getByText("$289.900", {
            selector: "[data-price-amount]",
          })
          .closest(".price-frame")
      ).toHaveAttribute("aria-hidden", "false");
      expect(
        screen
          .getByText("$28.900", {
            selector: "[data-price-amount]",
          })
          .closest(".price-frame")
      ).toHaveAttribute("aria-hidden", "true");
      fireEvent.click(
        screen.getByRole("button", {
          name: "Semanal",
        })
      );
      yield* nextPaint;
      expect(
        screen
          .getByText("$9.900", {
            selector: "[data-price-amount]",
          })
          .closest(".price-frame")
      ).toHaveAttribute("aria-hidden", "false");
      expect(
        within(screen.getByRole("banner")).getByRole("link", {
          name: "Crear mi cuenta",
        })
      ).toHaveAttribute("href", "/auth/google");
    })
  ));
it("registers and resets only the illustrative dashboard transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Registrar ejemplo",
        })
      );
      yield* nextPaint;
      expect(screen.getByText("$1.084.000")).toHaveAttribute("aria-hidden", "false");
      expect(screen.getByRole("status")).toHaveTextContent(
        "Una transacción de $28.000 registrada en Restaurantes."
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: /Reiniciar ejemplo/,
        }),
        {
          detail: 1,
        }
      );
      yield* nextPaint;
      expect(screen.getByText("$1.056.000")).toHaveAttribute("aria-hidden", "false");
    })
  ));
it("corrects the same illustrative transaction in its detail view and resets it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountNative("/funciones/transacciones");
      yield* nextPaint;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Probar una corrección",
        })
      );
      yield* nextPaint;
      expect(screen.getByText("$26.000 COP")).toBeInTheDocument();
      expect(screen.getByText("− $26.000")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Es la misma transacción.");
      fireEvent.click(
        screen.getByRole("button", {
          name: /Reiniciar ejemplo/,
        })
      );
      yield* nextPaint;
      expect(screen.getByText("$28.000 COP")).toBeInTheDocument();
    })
  ));
it("honors reduced motion and cancels owned animations on unmount", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      preference.matches = true;
      const view = mountNative("/");
      yield* nextPaint;
      expect(animate).toHaveBeenCalledWith(
        [
          {
            opacity: 0,
          },
          {
            opacity: 1,
          },
        ],
        expect.objectContaining({
          delay: 0,
          duration: 160,
        })
      );
      cancel.mockClear();
      view.unmount();
      yield* nextPaint;
      expect(cancel).toHaveBeenCalled();
    })
  ));
it("preserves browser scroll timelines while cleaning up owned animations in Strict Mode", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      class NativeScrollAnimation {
        cancel = vi.fn();
      }
      const scrollAnimation = new NativeScrollAnimation();
      const ownedAnimation = {
        cancel: vi.fn(),
      };
      vi.stubGlobal("CSS", {
        supports: () => true,
      });
      vi.stubGlobal("CSSAnimation", NativeScrollAnimation);
      Object.defineProperty(Element.prototype, "getAnimations", {
        configurable: true,
        value(this: Element) {
          return [scrollAnimation, ownedAnimation];
        },
      });
      const view = mountNative("/");
      yield* nextPaint;
      view.unmount();
      yield* nextPaint;
      expect(ownedAnimation.cancel).toHaveBeenCalled();
      expect(scrollAnimation.cancel).not.toHaveBeenCalled();
    })
  ));
it("restores a saved theme and tolerates unavailable browser storage", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      localStorage.setItem("fidy-landing-theme", "dark");
      const view = mountNative("/funciones/transacciones");
      yield* nextPaint;
      expect(
        screen.getByRole("button", {
          name: "Activar tema claro",
        })
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Activar tema claro",
        })
      );
      yield* nextPaint;
      expect(localStorage.getItem("fidy-landing-theme")).toBe("light");
      view.unmount();
      yield* nextPaint;
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("Storage unavailable");
        },
        setItem: () => {
          throw new Error("Storage unavailable");
        },
      });
      mountNative("/funciones/transacciones");
      yield* nextPaint;
      expect(
        screen.getByRole("button", {
          name: "Activar tema oscuro",
        })
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Activar tema oscuro",
        })
      );
      yield* nextPaint;
      expect(
        screen.getByRole("button", {
          name: "Activar tema claro",
        })
      ).toBeInTheDocument();
    })
  ));
it("explains the trial and exposes privacy, support and agent setup without changing signup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountNative("/");
      yield* nextPaint;
      expect(
        screen.getByText("7 días de Fidy Pro sin tarjeta. Tú eliges si te suscribes.")
      ).toBeVisible();
      const footer = screen.getByRole("navigation", {
        name: "Información y ayuda",
      });
      expect(
        within(footer).getByRole("link", {
          name: "Política de privacidad",
        })
      ).toHaveAttribute("href", "/politica");
      expect(
        within(footer).getByRole("link", {
          name: "Cookies y almacenamiento",
        })
      ).toHaveAttribute("href", "/cookies");
      expect(
        within(footer).getByRole("link", {
          name: "Contacto y soporte",
        })
      ).toHaveAttribute("href", "mailto:obarboza@fidyapp.com");
      expect(
        within(footer).getByRole("link", {
          name: "Conecta tu agente",
        })
      ).toHaveAttribute("href", "/funciones/agentes#conectar");
      for (const link of screen.getAllByRole("link", {
        name: /Crear mi cuenta/u,
      })) {
        expect(link).toHaveAttribute("href", "/auth/google");
      }
    })
  ));
it("offers least-privilege setup and keeps each revocation destination explicit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountNative("/funciones/agentes");
      yield* nextPaint;
      const guide = screen.getByRole("region", {
        name: "Conecta con contexto.",
      });
      expect(within(guide).getByText(/codex mcp login fidy --scopes read/u)).toBeVisible();
      expect(within(guide).queryByText(/todavía en preparación/u)).not.toBeInTheDocument();
      expect(
        within(guide).getByRole("link", {
          name: "Agentes conectados",
        })
      ).toHaveAttribute("href", "/settings/agents");
      expect(
        within(guide).getByText(/No hay un paquete público de instalación documentado/u)
      ).toBeInTheDocument();
    })
  ));
it("updates canonical and share metadata without retaining the previous public page description", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const home = mountNative("/");
      yield* nextPaint;
      expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
      expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
        "href",
        "https://app.fidyapp.com/"
      );
      home.unmount();
      yield* nextPaint;
      mountNative("/funciones/agentes");
      yield* nextPaint;
      expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
      expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute(
        "href",
        "https://app.fidyapp.com/funciones/agentes"
      );
      expect(document.head.querySelector('meta[property="og:url"]')).toHaveAttribute(
        "content",
        "https://app.fidyapp.com/funciones/agentes"
      );
    })
  ));
it("keeps legal review status separate from an active service agreement", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountNative("/");
      yield* nextPaint;
      expect(
        screen.getByRole("link", {
          name: "Términos de servicio (borrador)",
        })
      ).toHaveAttribute("href", "/terminos");
    })
  ));
it("uses concise first-use wording and the ChatGPT brand", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountNative("/");
      yield* nextPaint;
      expect(
        screen.getByRole("heading", {
          name: "Conéctalo a ChatGPT o Claude",
        })
      ).toBeVisible();
      expect(screen.getByText(/adjuntar un Excel por WhatsApp/u)).toBeVisible();
      expect(screen.queryByText(/Nunca envíes claves/u)).not.toBeInTheDocument();
      expect(screen.queryByText(/Fidy refleja la información/u)).not.toBeInTheDocument();
      expect(screen.queryByText(/CSV o XLSX/u)).not.toBeInTheDocument();
    })
  ));
it("retargets the tab underline after wrapping and releases its resize subscription", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let resize = (): void => {};
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe(): void {}
          disconnect = disconnect;
        }
      );
      const view = mountNative("/");
      yield* nextPaint;
      const tab = screen.getByRole("tab", {
        name: "Presupuestos",
      });
      Object.defineProperties(tab, {
        offsetLeft: {
          configurable: true,
          value: 180,
        },
        offsetTop: {
          configurable: true,
          value: 48,
        },
        offsetHeight: {
          configurable: true,
          value: 48,
        },
        offsetWidth: {
          configurable: true,
          value: 160,
        },
      });
      fireEvent.click(tab, {
        detail: 1,
      });
      yield* nextPaint;
      const list = screen.getByRole("tablist");
      expect(list.querySelector(".feature-indicator")).toHaveStyle({
        transform: "translate(180px, 93px) scaleX(160)",
      });
      expect(list).toHaveAttribute("data-instant", "false");
      Object.defineProperty(tab, "offsetLeft", {
        value: 0,
      });
      resize();
      expect(list.querySelector(".feature-indicator")).toHaveStyle({
        transform: "translate(0px, 93px) scaleX(160)",
      });
      expect(list).toHaveAttribute("data-instant", "true");
      view.unmount();
      yield* nextPaint;
      expect(disconnect).toHaveBeenCalled();
    })
  ));
it("preserves native FAQ toggling with immediate keyboard and animated pointer intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const summary = screen.getByText("¿Puedo corregir una transacción?");
      const details = summary.closest("details");
      fireEvent.click(summary, {
        detail: 1,
      });
      yield* nextPaint;
      expect(details).toHaveAttribute("open");
      expect(details).toHaveAttribute("data-instant", "false");
      fireEvent.click(summary, {
        detail: 0,
      });
      yield* nextPaint;
      expect(details).not.toHaveAttribute("open");
      expect(details).toHaveAttribute("data-instant", "true");
    })
  ));
it("defers a backgrounded demonstration and settles it when visibility changes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      mountHome();
      yield* nextPaint;
      const shell = screen.getByText("Tu asistente · WhatsApp").closest(".demo-shell");
      if (shell === null) throw new Error("Missing conversation shell");
      animate.mockClear();
      intersections.get(shell)?.(true);
      expect(animate).not.toHaveBeenCalled();
      hidden.mockReturnValue(false);
      intersections.get(shell)?.(true);
      expect(animate).toHaveBeenCalled();
      cancel.mockClear();
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(cancel).toHaveBeenCalled();
      hidden.mockRestore();
    })
  ));
it("plays pointer-selected chat and chart previews while keeping tab explanations available", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      fireEvent.click(
        screen.getByRole("button", {
          name: "Consultar",
        }),
        {
          detail: 1,
        }
      );
      yield* nextPaint;
      expect(
        screen.getByRole("button", {
          name: "Consultar",
        })
      ).toHaveAttribute("aria-pressed", "true");
      for (const name of ["Asistente", "Dashboard", "Presupuestos"]) {
        animate.mockClear();
        fireEvent.click(
          screen.getByRole("tab", {
            name,
          }),
          {
            detail: 1,
          }
        );
        yield* nextPaint;
        expect(screen.getByRole("tabpanel")).toHaveAccessibleName(name);
        expect(animate).toHaveBeenCalled();
      }
    })
  ));
it("keeps feature selection usable without ResizeObserver", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.stubGlobal("ResizeObserver", undefined);
      mountHome();
      yield* nextPaint;
      fireEvent.keyDown(
        screen.getByRole("tab", {
          name: "Transacciones",
        }),
        {
          key: "ArrowRight",
        }
      );
      yield* nextPaint;
      expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Presupuestos");
      expect(
        screen.getByRole("tab", {
          name: "Presupuestos",
        })
      ).toHaveFocus();
    })
  ));
it("leaves absent demonstration artwork alone and returns safe cleanup", () => {
  const placeholder = document.createElement("div");
  animate.mockClear();
  cancel.mockClear();
  const releaseConversation = mountConversation(placeholder);
  const releasePreview = mountPreview(placeholder);
  releaseConversation();
  releasePreview();
  expect(animate).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
it("tolerates a detached tab and a tablist whose active content has been removed", () => {
  const detached = document.createElement("button");
  const emptyList = document.createElement("div");
  expect(() =>
    moveIndicator({
      tab: detached,
      instant: true,
    })
  ).not.toThrow();
  const release = mountIndicator(emptyList);
  expect(emptyList.children).toHaveLength(0);
  release();
});
it("keeps compact navigation named and dismisses the selected destination", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const panel = screen.getByLabelText("Navegación compacta");
      const hide = vi.fn();
      Object.defineProperty(panel, "hidePopover", { value: hide });
      expect(screen.getByRole("navigation", { name: "Principal" })).toBeInTheDocument();
      const trigger = screen.getByRole("button", { name: "Menú de navegación" });
      fireEvent.click(trigger, { detail: 1 });
      expect(panel).toHaveAttribute("data-motion", "pointer");
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(panel).toHaveAttribute("data-motion", "instant");
      fireEvent.click(trigger, { detail: 0 });
      expect(panel).toHaveAttribute("data-motion", "instant");
      const destination = panel.querySelector("a");
      if (destination === null) throw new Error("Compact navigation destination missing");
      fireEvent.keyDown(destination, { key: "Tab" });
      fireEvent.keyDown(destination, { key: "Escape" });
      fireEvent.click(destination);
      expect(hide).toHaveBeenCalledOnce();
    })
  ));
it("renders every public destination through its native page program", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const page of [
        "/",
        "/politica",
        "/cookies",
        "/terminos",
        "/missing",
        ...["transacciones", "presupuestos", "asistente", "tablero", "insights", "agentes"].map(
          (slug) => `/funciones/${slug}`
        ),
      ]) {
        const mounted = mountNative(page);
        yield* nextPaint;
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
        mounted.unmount();
        yield* nextPaint;
      }
    })
  ));
it("moves the feature underline on roving keyboard focus", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      mountHome();
      yield* nextPaint;
      const tab = screen.getByRole("tab", { name: "Presupuestos" });
      Object.defineProperties(tab, {
        offsetLeft: { value: 110 },
        offsetTop: { value: 10 },
        offsetHeight: { value: 40 },
        offsetWidth: { value: 120 },
      });
      fireEvent.keyDown(screen.getByRole("tab", { name: "Transacciones" }), { key: "ArrowRight" });
      yield* nextPaint;
      expect(tab).toHaveFocus();
      expect(document.querySelector(".feature-indicator")).toHaveStyle({
        transform: "translate(110px, 47px) scaleX(120)",
      });
      expect(tab.parentElement).toHaveAttribute("data-instant", "true");
    })
  ));
const mountNative = (page: string): ReturnType<typeof renderFoldkit> =>
  renderFoldkit((container) => mountPublicSite({ container, page, headOwnership: "Feature" }));
const nextPaint: Effect.Effect<void> = Effect.callback((resume) => {
  const frame = requestAnimationFrame(() => queueMicrotask(() => resume(Effect.void)));
  return Effect.sync(() => cancelAnimationFrame(frame));
});
