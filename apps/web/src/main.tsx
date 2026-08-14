import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { Option } from "effect";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeFidyClient } from "./api-client";
import { parseApiOrigin } from "./api-origin";
import "./index.css";
import { createWebRouter } from "./router";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Web application root is missing");
}

const apiClient = makeFidyClient(parseApiOrigin(import.meta.env.VITE_API_ORIGIN));
const router = createWebRouter({ apiClient, history: Option.none() });

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>
);
