import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";

const publicDirectory = (mode: string): string | false => {
  if (mode === "production") return "cloudflare/production";
  return false;
};

export default defineConfig(({ mode }) => ({
  plugins: [serverClientBoundary(), tailwindcss()],
  publicDir: publicDirectory(mode),
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
