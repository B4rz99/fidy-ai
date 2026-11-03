import { StrictMode } from "react";
import { RouterContextProvider, createRootRoute, createRouter } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { UIReference } from "@/ui/reference";
import "@/index.css";

if (import.meta.env.DEV) {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("UI reference root is missing");
  const router = createRouter({ routeTree: createRootRoute() });
  createRoot(root).render(
    <StrictMode>
      <RouterContextProvider router={router}>
        <UIReference />
      </RouterContextProvider>
    </StrictMode>
  );
}
