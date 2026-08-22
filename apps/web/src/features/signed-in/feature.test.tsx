import { Effect } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationExpired, CurrentUserResultView } from "./feature";
import { completeLogoutNavigation, makeLogoutOperation } from "./logout";

describe("current User result", () => {
  afterEach(cleanup);

  it("explains an expired authentication lifetime", () => {
    render(<AuthenticationExpired />);

    expect(screen.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible();
  });

  it("renders the current locale and time zone and delegates logout", () => {
    const onLogout = vi.fn();
    render(
      <CurrentUserResultView
        onLogout={onLogout}
        result={AsyncResult.success({
          data: { locale: "es-CO", timeZone: "America/Bogota" },
        })}
      />
    );

    expect(screen.getByText("es-CO")).toBeVisible();
    expect(screen.getByText("America/Bogota")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("renders the current-User failure state", () => {
    render(<CurrentUserResultView onLogout={vi.fn()} result={AsyncResult.fail("unavailable")} />);

    expect(screen.getByText("No pudimos cargar tu perfil")).toBeVisible();
  });

  it("renders the current-User loading state", () => {
    render(<CurrentUserResultView onLogout={vi.fn()} result={AsyncResult.initial(true)} />);

    expect(screen.getByLabelText("Cargando perfil")).toBeVisible();
  });
});

describe("signed-in logout", () => {
  it("publishes logout completion only after transport succeeds", async () => {
    const onLoggedOut = vi.fn();

    await Effect.runPromise(makeLogoutOperation(Effect.void)({ onLoggedOut }));

    expect(onLoggedOut).toHaveBeenCalledOnce();
  });

  it("completes local logout and tolerates finished navigation rejection", async () => {
    const completeLogout = vi.fn();
    const navigate = vi.fn(() => Promise.reject(new Error("route disposed")));

    completeLogoutNavigation({
      completeLogout,
      navigate,
      runLogout: ({ onLoggedOut }) => onLoggedOut(),
    });
    await Promise.resolve();

    expect(completeLogout).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
  });
});
