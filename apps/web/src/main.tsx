import { mountWebApplication } from "@/app/mount";
import "./index.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Web application root is missing");
}

// The static shell is readable without JavaScript; React owns page-specific metadata after mount.
for (const metadata of document.querySelectorAll("[data-fidy-public-meta]")) metadata.remove();

mountWebApplication(root);
