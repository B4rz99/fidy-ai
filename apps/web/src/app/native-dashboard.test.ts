import { waitFor } from "@testing-library/dom";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { mountDashboardPage } from "./native-dashboard";

afterEach(() => {
  vi.doUnmock("@/features/dashboard/feature");
  vi.resetModules();
});

it("releases an acquired Dashboard when its route closes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const released = vi.fn();
      const mounted = vi.fn(() => released);
      vi.doMock("@/features/dashboard/feature", () => ({ mountDashboard: mounted }));
      const lifetime = makeAuthenticationLifetime({
        apiOrigin: "https://api.test",
        onExpired: () => undefined,
      });
      const container = document.createElement("div");
      const dispose = mountDashboardPage({ container, lifetime });
      expect(container).toHaveTextContent("Cargando tablero");
      yield* Effect.tryPromise(() => waitFor(() => expect(mounted).toHaveBeenCalledOnce()));
      dispose();
      lifetime.dispose();
      expect(released).toHaveBeenCalledOnce();
      expect(container).toBeEmptyDOMElement();
    })
  ));

it("never acquires a Dashboard after immediate route teardown", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mounted = vi.fn(() => (): void => undefined);
      vi.doMock("@/features/dashboard/feature", () => ({ mountDashboard: mounted }));
      const lifetime = makeAuthenticationLifetime({
        apiOrigin: "https://api.test",
        onExpired: () => undefined,
      });
      const container = document.createElement("div");
      mountDashboardPage({ container, lifetime })();
      lifetime.dispose();
      yield* Effect.sleep("20 millis");
      expect(mounted).not.toHaveBeenCalled();
      expect(container).toBeEmptyDOMElement();
    })
  ));

it("shows an actionable failure when the Dashboard chunk cannot load", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      vi.doMock("@/features/dashboard/feature", () => {
        throw new Error("synthetic-chunk-failure");
      });
      const lifetime = makeAuthenticationLifetime({
        apiOrigin: "https://api.test",
        onExpired: () => undefined,
      });
      const container = document.createElement("div");
      const dispose = mountDashboardPage({ container, lifetime });
      yield* Effect.tryPromise(() =>
        waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull())
      );
      expect(container).toHaveTextContent("Recarga la página");
      expect(container).not.toHaveTextContent("synthetic-chunk-failure");
      dispose();
      lifetime.dispose();
      expect(container).toBeEmptyDOMElement();
    })
  ));
