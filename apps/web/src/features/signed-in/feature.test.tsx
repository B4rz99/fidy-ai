import { Effect } from "effect";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationExpired } from "./feature";
import { completeLogoutNavigation, makeLogoutOperation } from "./logout";

describe("signed-in authentication lifetime", () => {
  afterEach(cleanup);

  it("explains an expired authentication lifetime", () => {
    render(<AuthenticationExpired />);

    expect(screen.getByText("Tu sesión venció. Inicia sesión de nuevo.")).toBeVisible();
  });

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
