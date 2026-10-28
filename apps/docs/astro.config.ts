import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.fidyapp.com",
  output: "static",
  markdown: { syntaxHighlight: "prism" },
  trailingSlash: "never",
  build: { format: "directory", inlineStylesheets: "never" },
  security: {
    csp: {
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      styleDirective: { resources: ["'self'", { resource: "'unsafe-inline'", kind: "attribute" }] },
      directives: [
        "default-src 'none'",
        "base-uri 'none'",
        "connect-src 'self'",
        "font-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'",
        "form-action 'none'",
      ],
    },
  },
  integrations: [
    starlight({
      title: "Fidy · Guías",
      description: "Guías de Fidy para personas y sus propios agentes.",
      components: { MarkdownContent: "./src/components/markdown-content.astro" },
      social: [{ icon: "external", label: "Abrir Fidy", href: "https://app.fidyapp.com" }],
      lastUpdated: false,
      locales: { root: { label: "Español", lang: "es" } },
      customCss: ["./src/styles/fidy.css"],
      sidebar: [
        { label: "Empieza aquí", items: [{ label: "Guía de Fidy", slug: "" }] },
        {
          label: "Conectar mi agente",
          items: ["conectar/mcp", "conectar/claude-code", "conectar/codex", "conectar/cli"],
        },
        {
          label: "Tus transacciones",
          items: ["transacciones/registrar-corregir", "consultar/finanzas"],
        },
        { label: "Acceso y ayuda", items: ["acceso/permisos", "ayuda/problemas"] },
        { label: "Uso avanzado", items: ["avanzado/api", "referencia/esquemas"] },
        {
          label: "Referencia",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
      ],
    }),
  ],
});
