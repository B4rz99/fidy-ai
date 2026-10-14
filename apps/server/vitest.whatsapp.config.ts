import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/shell/channels/whatsapp/**/*.test.ts"],
    clearMocks: true,
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
