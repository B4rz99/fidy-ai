import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebApplication } from "@/app/application";
import "./index.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Web application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <WebApplication />
  </StrictMode>
);
