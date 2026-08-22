import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Option } from "effect";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApplication } from "@/app/application";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient, makeWebAuthClient } from "@/transport/client";

const renderRoute = async (path: string): Promise<void> => {
  const apiOrigin = "https://api.test.fidyapp.com";
  const router = createWebRouter({
    apiClient: makeFidyClient(apiOrigin),
    webAuthClient: makeWebAuthClient(apiOrigin),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  render(
    <SessionRegistryProvider>
      <RouterProvider router={router} />
    </SessionRegistryProvider>
  );
  await router.load();
};

describe("web application routes", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });
  it("renders the minimal root through the real router and Atom provider", async () => {
    await renderRoute("/");

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });

  it("renders the authoritative policy at its stable route", async () => {
    await renderRoute("/politica");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Política de tratamiento de datos personales",
      })
    ).toBeVisible();
    expect(screen.getByText("policy-2026-08-03")).toBeVisible();
    expect(screen.getByText(/Fidy usa OpenAI/iu)).toBeVisible();
    expect(screen.getByText(/Estados Unidos/iu)).toBeVisible();
    expect(screen.queryByText(/cuentas|saldos/iu)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /términos de servicio/iu })).not.toBeInTheDocument();
  });

  it("does not start browser pairing merely by opening its route", async () => {
    await renderRoute("/auth/pair");

    expect(await screen.findByRole("heading", { name: "Inicia sesión en Fidy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Iniciar sesión en el navegador" })).toBeVisible();
    expect(screen.queryByText(/pairing code/iu)).not.toBeInTheDocument();
  });

  it("renders not-found behavior for an unknown route", async () => {
    await renderRoute("/ruta-inexistente");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeVisible();
  });

  it("uses the configured browser application origin", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.test.fidyapp.com");
    render(<WebApplication />);

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });
});
