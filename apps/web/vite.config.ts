import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";

export default defineConfig({
  plugins: [serverClientBoundary(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
