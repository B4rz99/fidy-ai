import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UIReference } from "@/ui/reference";
import "@/index.css";

if (import.meta.env.DEV) {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("UI reference root is missing");
  createRoot(root).render(
    <StrictMode>
      <UIReference />
    </StrictMode>
  );
}
