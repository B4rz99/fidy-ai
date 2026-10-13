import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://fidyapp.com",
  output: "static",
  markdown: { syntaxHighlight: "prism" },
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "never" },
  integrations: [
    react(),
    sitemap({ filter: (page) => !page.endsWith("/terminos") && !page.endsWith("/404") }),
  ],
  security: {
    csp: {
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
  vite: { plugins: [tailwindcss()], server: { strictPort: true } },
});
