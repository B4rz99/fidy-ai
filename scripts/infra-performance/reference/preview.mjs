import { readFile } from "node:fs/promises";
import { preview } from "vite";

const server = await preview({
  root: process.cwd(),
  build: { outDir: "playwright-dist" },
  preview: {
    port: 4183,
    host: "127.0.0.1",
    strictPort: true,
    https: {
      key: await readFile(process.env.PLAYWRIGHT_TLS_KEY),
      cert: await readFile(process.env.PLAYWRIGHT_TLS_CERT),
    },
  },
});
process.on("SIGTERM", () => server.close());
