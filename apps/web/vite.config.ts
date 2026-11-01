import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serverClientBoundary } from "./server-client-boundary.ts";
import { entryPreload } from "./entry-preload.ts";

const publicDirectory = (mode: string): string | false => {
  if (mode === "production") return "cloudflare/production";
  return false;
};

export default defineConfig(({ mode }) => ({
  plugins: [serverClientBoundary(), react(), tailwindcss(), entryPreload()],
  publicDir: publicDirectory(mode),
  build: {
    rolldownOptions: {
      preserveEntrySignatures: false,
      output: {
        codeSplitting: {
          // Avoid tiny shared-module requests while keeping styles in their extracted files.
          experimentalInlineCommonChunks: {
            maxSize: 20_000,
            exclude: /\.css(?:\?|$)/u,
          },
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
}));
