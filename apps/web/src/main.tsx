import { mountWebApplication } from "@/app/mount";
import "./index.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Web application root is missing");
}

mountWebApplication(root);
