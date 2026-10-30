import { createServer } from "vite";
import { browserAcceptanceTopology } from "../../server/cloudflare/browser-acceptance/operations";

const server = await createServer({
  server: {
    hmr: false,
    ws: false,
    host: "127.0.0.1",
    port: browserAcceptanceTopology().appPort,
    strictPort: true,
    https: {
      key: await Bun.file("/tmp/fidy-playwright-key.pem").text(),
      cert: await Bun.file("/tmp/fidy-playwright-cert.pem").text(),
    },
  },
});
await server.listen();
