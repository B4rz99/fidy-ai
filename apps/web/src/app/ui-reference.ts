import { mountUIReference } from "@/ui/reference";
import "@/index.css";

// This separate Vite entry is for local design review; the production build uses index.html.
if (import.meta.env.DEV) {
  const root = document.querySelector<HTMLElement>("#root");
  if (root === null) throw new Error("UI reference root is missing");
  mountUIReference(root);
}
