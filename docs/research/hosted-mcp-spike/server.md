# Disposable server.mjs

Extract the following block into `server.mjs` in an isolated directory with the pinned package manifest. This is executable research evidence, not workspace application code.

```js
// Disposable protocol fixture; deliberately no Fidy identity, data or credentials.
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpServer from "effect/ai/McpServer";
import * as HttpRouter from "effect/http/HttpRouter";

export function makeProtocol(legacy = false) {
  return HttpRouter.toWebHandler(
    McpServer.layerHttp({
      name: "fidy-disposable-spike",
      version: "0.0.0",
      path: "/mcp",
      protocols: legacy
        ? [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25]
        : [McpProtocol.v2026_07_28],
      allowedOrigins: [],
    }),
    { disableLogger: true }
  );
}

if (import.meta.main) {
  const protocol = makeProtocol(process.argv.includes("--legacy"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 19770, fetch: protocol.handler });
  console.log(`Disposable MCP listening on ${server.url}mcp`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await server.stop(true);
      await protocol.dispose();
      process.exit(0);
    });
  }
}
```
