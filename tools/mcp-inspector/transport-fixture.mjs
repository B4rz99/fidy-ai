import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createSecureServer } from "node:http2";

// Initialize Node's own dispatcher before importing any optional external package.
// Otherwise a nominal baseline can silently exercise Undici's replacement instead.
await fetch("data:text/plain,initialize-native-fetch");
const { Client, StreamableHTTPClientTransport, parseJSONRPCMessage } =
  await import("@modelcontextprotocol/client");
const { getGlobalDispatcher } = await import("undici");
const directory = process.argv[2];
const concurrent = process.argv[3] === "concurrent";
/** @type {Set<import("node:http2").ServerHttp2Session>} */
const sessions = new Set();
const versions = new Set();
/** @type {PromiseWithResolvers<void>} */
const reviewSeen = Promise.withResolvers();
/** @type {import("node:http2").Http2ServerResponse | undefined} */
let reviewResponse;
/** @type {string | number | undefined} */
let reviewCallId;
let cancellationReceived = false;
let readWhilePending = false;
const status = { ok: 200, accepted: 202, invalid: 400, unsupported: 405 };
/**
 * @param {import("node:http2").Http2ServerResponse} response The owned HTTP/2 response.
 * @param {string | number} id The JSON-RPC request identity.
 * @param {unknown} result The fixture result to serialize.
 */
const jsonReply = (response, id, result) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
/**
 * @param {import("node:http2").Http2ServerResponse} response The owned review stream.
 * @param {string | number} id The original tool request identity.
 */
const review = (response, id) => {
  reviewResponse = response;
  reviewCallId = id;
  response.writeHead(status.ok, { "content-type": "text/event-stream" });
  response.write(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: "disposable-review",
      method: "elicitation/create",
      params: {
        message: "Cancel this disposable review",
        requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } },
      },
    })}\n\n`
  );
};
/**
 * @param {import("node:http2").Http2ServerResponse} response The cancellation acknowledgment.
 * @param {unknown} result The native decision to validate.
 */
const complete = (response, result) => {
  assert.deepEqual(result, { action: "cancel" });
  assert.ok(reviewResponse);
  cancellationReceived = true;
  response.writeHead(status.accepted).end();
  reviewResponse.end(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: reviewCallId,
      result: {
        isError: true,
        structuredContent: { error: { code: "user_action_required" } },
        content: [{ type: "text", text: "Confirmation cancelled" }],
      },
    })}\n\n`
  );
};
/**
 * @param {import("node:http2").Http2ServerResponse} response The owned HTTP/2 response.
 * @param {ReturnType<typeof parseJSONRPCMessage>} message The decoded MCP message.
 */
const receiveMessage = (response, message) => {
  if ("result" in message) return complete(response, message.result);
  assert.ok("method" in message);
  response.setHeader("mcp-session-id", "disposable-loopback-session");
  switch (message.method) {
    case "initialize":
      assert.ok("id" in message);
      return jsonReply(response, message.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "disposable-loopback", version: "1" },
      });
    case "notifications/initialized":
      return response.writeHead(status.accepted).end();
    case "tools/call":
      assert.ok("id" in message);
      if (message.params?.name === "review") return review(response, message.id);
      assert.equal(message.params?.name, "read");
      readWhilePending = !cancellationReceived;
      return jsonReply(response, message.id, { content: [] });
    default:
      return response.writeHead(status.invalid).end();
  }
};
const server = createSecureServer(
  {
    allowHTTP1: false,
    key: await readFile(`${directory}/key.pem`),
    cert: await readFile(`${directory}/cert.pem`),
    settings: { maxConcurrentStreams: 100 },
  },
  (request, response) => {
    receiveRequest(request, response).catch(() => {
      process.exitCode = 1;
      response.destroy();
    });
  }
);
/**
 * @param {import("node:http2").Http2ServerRequest} request The loopback request to decode.
 * @param {import("node:http2").Http2ServerResponse} response The owned response.
 */
const receiveRequest = async (request, response) => {
  versions.add(request.httpVersion);
  if (request.method === "GET") return response.writeHead(status.unsupported).end();
  if (request.method === "DELETE") return response.writeHead(status.ok).end();
  assert.equal(request.headers.authorization, "Bearer disposable-loopback-token");
  let body = "";
  for await (const chunk of request) body += chunk;
  receiveMessage(response, parseJSONRPCMessage(JSON.parse(body)));
};
server.on("session", (session) => {
  sessions.add(session);
  session.on("close", () => sessions.delete(session));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const client = new Client(
  { name: "disposable-inspector-comparison", version: "1" },
  {
    capabilities: { elicitation: { form: {} } },
    supportedProtocolVersions: ["2025-11-25"],
    versionNegotiation: { mode: "legacy" },
  }
);
client.setRequestHandler("elicitation/create", async () => {
  reviewSeen.resolve();
  // Give the competing POST time to reach the server before cancelling the form.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { action: "cancel" };
});
const address = server.address();
assert.ok(address && typeof address === "object");
const transport = new StreamableHTTPClientTransport(
  new URL(`https://127.0.0.1:${address.port}/mcp`),
  {
    authProvider: {
      token: async () => "disposable-loopback-token",
    },
  }
);
try {
  await client.connect(transport);
  const review = client.callTool({ name: "review", arguments: {} }, { timeout: 2_500 });
  review.catch(() => {});
  await reviewSeen.promise;
  if (concurrent) await client.callTool({ name: "read", arguments: {} }, { timeout: 2_500 });
  const result = await review;
  assert.deepEqual(result.structuredContent, { error: { code: "user_action_required" } });
  assert.equal(cancellationReceived, true);
  assert.deepEqual([...versions], ["2.0"]);
  if (concurrent) assert.equal(readWhilePending, true);
  process.stdout.write(
    JSON.stringify({ passed: true, http2: true, cancellationReceived, concurrent }) + "\n"
  );
} catch {
  process.stdout.write(JSON.stringify({ passed: false, cancellationReceived, concurrent }) + "\n");
  process.exitCode = 1;
} finally {
  // Close the owned sockets even if the client's timeout cancellation is itself queued.
  for (const session of sessions) session.destroy();
  await client.close();
  await new Promise((resolve) => server.close(resolve));
  await getGlobalDispatcher().destroy();
}
