import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LoadingReference } from "@/ui/loading-reference";
import "@/index.css";

if (import.meta.env.DEV) {
  const root = document.querySelector("#root");
  if (root === null) throw new Error("Loading preview root is missing");
  createRoot(root).render(
    <StrictMode>
      <LoadingReference />
    </StrictMode>
  );
}
