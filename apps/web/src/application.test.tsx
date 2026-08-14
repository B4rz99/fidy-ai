import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Option } from "effect";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeFidyClient } from "./api-client";
import { createWebRouter } from "./router";

const renderRoute = async (path: string): Promise<void> => {
  const router = createWebRouter({
    apiClient: makeFidyClient("https://api.test.fidyapp.com"),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  render(
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  );
  await router.load();
};

describe("web application routes", () => {
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

  it("renders not-found behavior for an unknown route", async () => {
    await renderRoute("/ruta-inexistente");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeVisible();
  });
});
