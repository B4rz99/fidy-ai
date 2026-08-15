import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";

const publicDirectory = (mode: string): string | false => {
  if (mode === "preview") return "cloudflare/public";
  if (mode === "production") return "cloudflare/production";
  return false;
};

export default defineConfig(({ mode }) => ({
  plugins: [serverClientBoundary(), react(), tailwindcss()],
  publicDir: publicDirectory(mode),
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
