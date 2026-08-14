import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { serverClientBoundary } from "./server-client-boundary.ts";

export default defineConfig({
  plugins: [serverClientBoundary(), react()],
  resolve: {
    alias: {
      "@": Bun.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/testing/setup.ts"],
  },
});
