import { readdir } from "node:fs/promises";

const publicFiles = new Set([
  "_headers",
  "_redirects",
  "robots.txt",
  "llms.txt",
  "sitemap-index.xml",
  "sitemap-0.xml",
  "fidy-logo.png",
  "deployment-metadata.json",
]);
const pages =
  /^(?:index|cookies|politica|terminos|404|funciones\/(?:transacciones|presupuestos|asistente|tablero|insights|agentes))\.html$/u;
const assets = /^_astro\/[^/]+\.[A-Za-z0-9_-]{8,}\.(?:js|css|woff2)$/u;

for (const path of await readdir(new URL("../dist", import.meta.url), { recursive: true })) {
  if (path === "_astro" || path === "funciones") continue;
  if (!publicFiles.has(path) && !pages.test(path) && !assets.test(path)) {
    throw new Error(`Forbidden site output: ${path}`);
  }
}
