import { mountProductionApplication } from "@/app/native-program";
import { parseApiOrigin } from "@/transport/origin";
import "./index.css";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) {
  throw new Error("Web application root is missing");
}

// The static shell is readable without JavaScript; the Foldkit application owns page metadata.
for (const metadata of document.querySelectorAll("[data-fidy-public-meta]")) metadata.remove();
mountProductionApplication({
  container: root,
  apiOrigin: parseApiOrigin(import.meta.env.VITE_API_ORIGIN),
});
