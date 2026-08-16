import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { Option } from "effect";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebApplication } from "@/app/application";
import { createWebApplication } from "@/app/create-application";
import { createWebRouter } from "@/app/routes";
import { SessionRegistryProvider } from "@/session/session";
import { makeFidyClient } from "@/transport/client";

const renderRoute = async (path: string): Promise<void> => {
  const router = createWebRouter({
    apiClient: makeFidyClient("https://api.test.fidyapp.com"),
    history: Option.some(createMemoryHistory({ initialEntries: [path] })),
  });

  render(
    <SessionRegistryProvider authenticationLifetime={`test-${path}`}>
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

  it("renders not-found behavior for an unknown route", async () => {
    await renderRoute("/ruta-inexistente");

    expect(await screen.findByRole("heading", { name: "Página no encontrada" })).toBeVisible();
  });

  it("composes the application with an injected memory history", async () => {
    render(
      createWebApplication({
        apiOrigin: "https://api.test.fidyapp.com",
        history: Option.some(createMemoryHistory({ initialEntries: ["/"] })),
      })
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });

  it("uses the configured browser application origin", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.test.fidyapp.com");
    render(<WebApplication />);

    expect(await screen.findByRole("heading", { level: 1, name: "Fidy" })).toBeVisible();
  });
});
