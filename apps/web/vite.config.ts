import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";

export default defineConfig(({ mode }) => ({
  plugins: [serverClientBoundary(), react(), tailwindcss()],
  publicDir: mode === "preview" ? "cloudflare/public" : false,
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
