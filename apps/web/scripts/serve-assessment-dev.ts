import { createServer } from "vite";

const server = await createServer({
  server: {
    hmr: false,
    ws: false,
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    https: {
      key: await Bun.file("/tmp/fidy-playwright-key.pem").text(),
      cert: await Bun.file("/tmp/fidy-playwright-cert.pem").text(),
    },
  },
});
await server.listen();
