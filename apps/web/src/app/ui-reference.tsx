import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UIReference } from "@/ui/reference";
import "@/index.css";

// This separate Vite entry is for local design review; the production build uses index.html.
if (import.meta.env.DEV) {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("UI reference root is missing");
  createRoot(root).render(
    <StrictMode>
      <UIReference />
    </StrictMode>
  );
}
