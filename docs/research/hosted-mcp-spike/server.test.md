# Disposable server.test.mjs

Extract the following block into `server.test.mjs` in an isolated directory with the pinned package manifest. This is executable research evidence, not workspace application code.

```js
import { expect, test } from "bun:test";
import { makeProtocol } from "./server.mjs";

test("stateless discovery works without initialization and rejects a foreign browser origin", async () => {
  const protocol = makeProtocol();
  try {
    const request = (origin) =>
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
    const response = await protocol.handler(request());
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).toEqual([]);
    expect((await protocol.handler(request("https://attacker.example"))).status).toBe(403);
  } finally {
    await protocol.dispose();
  }
});
```
